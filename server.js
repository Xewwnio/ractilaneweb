const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Пути
const DB_PATH = path.join(__dirname, 'база данных');
const UPLOADS_PATH = path.join(__dirname, 'uploads');

// Создаем папки
fs.ensureDirSync(DB_PATH);
fs.ensureDirSync(UPLOADS_PATH);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_PATH));

// Инициализация базы данных
function initDB() {
    const files = {
        'users.json': [{
            name: 'Xewwnio',
            user: 'xewwnio',
            pass: 'ractilane1dvd',
            avatar: '',
            role: 'Developer',
            verified: true,
            banned: false,
            registered: Date.now()
        }],
        'messages.json': { 'global': [] },
        'channels.json': [],
        'chats.json': [],
        'online.json': []
    };
    
    Object.entries(files).forEach(([file, content]) => {
        const filePath = path.join(DB_PATH, file);
        if (!fs.existsSync(filePath)) {
            fs.writeJsonSync(filePath, content, { spaces: 2 });
        }
    });
}
initDB();

// Функции для работы с БД
function readDB(file) {
    try {
        return fs.readJsonSync(path.join(DB_PATH, file));
    } catch (err) {
        console.error('Ошибка чтения БД:', err);
        return null;
    }
}

function writeDB(file, data) {
    try {
        fs.writeJsonSync(path.join(DB_PATH, file), data, { spaces: 2 });
        return true;
    } catch (err) {
        console.error('Ошибка записи БД:', err);
        return false;
    }
}

// Multer для загрузки файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_PATH),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// ============== API ==============

// Регистрация
app.post('/api/register', upload.single('avatar'), (req, res) => {
    const { name, user, pass } = req.body;
    const users = readDB('users.json');
    
    if (users.find(u => u.user === user.toLowerCase())) {
        return res.json({ success: false, error: 'Юз уже занят' });
    }
    
    const newUser = {
        name,
        user: user.toLowerCase(),
        pass,
        avatar: req.file ? '/uploads/' + req.file.filename : '',
        role: user.toLowerCase() === 'xewwnio' ? 'admin' : 'user',
        verified: false,
        banned: false,
        registered: Date.now()
    };
    
    users.push(newUser);
    writeDB('users.json', users);
    
    res.json({ success: true });
});

// Авторизация
app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    const users = readDB('users.json');
    
    const found = users.find(u => u.user === user.toLowerCase() && u.pass === pass);
    
    if (!found) {
        return res.json({ success: false, error: 'Неверный юз или пароль' });
    }
    
    if (found.banned) {
        return res.json({ success: false, error: 'Вы забанены' });
    }
    
    // Добавляем в онлайн
    const online = readDB('online.json');
    if (!online.includes(found.user)) {
        online.push(found.user);
        writeDB('online.json', online);
    }
    
    res.json({ 
        success: true, 
        user: {
            name: found.name,
            user: found.user,
            avatar: found.avatar,
            role: found.role,
            verified: found.verified,
            registered: found.registered
        }
    });
});

// Выход
app.post('/api/logout', (req, res) => {
    const { user } = req.body;
    const online = readDB('online.json');
    writeDB('online.json', online.filter(u => u !== user));
    res.json({ success: true });
});

// Получить онлайн
app.get('/api/online', (req, res) => {
    const online = readDB('online.json');
    res.json({ count: online.length, users: online });
});

// Получить сообщения
app.get('/api/messages/:chatId', (req, res) => {
    const messages = readDB('messages.json');
    res.json(messages[req.params.chatId] || []);
});

// Отправить сообщение
app.post('/api/messages', (req, res) => {
    const { chatId, from, text } = req.body;
    const messages = readDB('messages.json');
    
    if (!messages[chatId]) {
        messages[chatId] = [];
    }
    
    const newMsg = {
        from,
        text,
        time: Date.now(),
        id: Date.now() + '-' + Math.random()
    };
    
    messages[chatId].push(newMsg);
    
    // Ограничиваем историю до 500 сообщений
    if (messages[chatId].length > 500) {
        messages[chatId] = messages[chatId].slice(-500);
    }
    
    writeDB('messages.json', messages);
    
    // Рассылаем через WebSocket
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'new_message',
                chatId,
                message: newMsg
            }));
        }
    });
    
    res.json({ success: true, message: newMsg });
});

// Получить чаты пользователя
app.get('/api/chats/:user', (req, res) => {
    const user = req.params.user;
    const chats = readDB('chats.json');
    const channels = readDB('channels.json');
    const users = readDB('users.json');
    
    const userChats = chats.filter(c => c.user1 === user || c.user2 === user);
    const userChannels = channels.filter(c => c.subscribers?.includes(user) || c.owner === user);
    
    res.json({
        chats: userChats,
        channels: userChannels,
        users: users.map(u => ({
            name: u.name,
            user: u.user,
            avatar: u.avatar,
            verified: u.verified,
            role: u.role
        }))
    });
});

// Создать личный чат
app.post('/api/chats', (req, res) => {
    const { user1, user2 } = req.body;
    const chats = readDB('chats.json');
    
    const chatId = [user1, user2].sort().join('_');
    
    if (!chats.find(c => c.id === chatId)) {
        chats.push({
            id: chatId,
            user1,
            user2,
            created: Date.now()
        });
        writeDB('chats.json', chats);
    }
    
    res.json({ success: true, chatId });
});

// Создать канал
app.post('/api/channels', (req, res) => {
    const { name, user, owner } = req.body;
    const channels = readDB('channels.json');
    
    if (channels.find(c => c.user === user.toLowerCase())) {
        return res.json({ success: false, error: 'Канал уже существует' });
    }
    
    const newChannel = {
        name,
        user: user.toLowerCase(),
        owner,
        subscribers: [owner],
        created: Date.now()
    };
    
    channels.push(newChannel);
    writeDB('channels.json', channels);
    
    res.json({ success: true, channel: newChannel });
});

// Подписаться на канал
app.post('/api/channels/subscribe', (req, res) => {
    const { channelUser, subscriber } = req.body;
    const channels = readDB('channels.json');
    
    const channel = channels.find(c => c.user === channelUser);
    if (channel) {
        if (!channel.subscribers) channel.subscribers = [];
        if (!channel.subscribers.includes(subscriber)) {
            channel.subscribers.push(subscriber);
            writeDB('channels.json', channels);
        }
    }
    
    res.json({ success: true });
});

// Поиск
app.get('/api/search/:query', (req, res) => {
    const query = req.params.query.toLowerCase();
    const users = readDB('users.json');
    const channels = readDB('channels.json');
    
    const foundUsers = users
        .filter(u => u.user.includes(query) || u.name.toLowerCase().includes(query))
        .map(u => ({ type: 'user', name: u.name, user: u.user, avatar: u.avatar, verified: u.verified }));
    
    const foundChannels = channels
        .filter(c => c.user.includes(query) || c.name.toLowerCase().includes(query))
        .map(c => ({ type: 'channel', name: c.name, user: c.user }));
    
    res.json([...foundUsers, ...foundChannels]);
});

// Админ: получить всех пользователей
app.get('/api/admin/users', (req, res) => {
    const users = readDB('users.json');
    res.json(users.map(u => ({
        name: u.name,
        user: u.user,
        role: u.role,
        verified: u.verified,
        banned: u.banned
    })));
});

// Админ: toggle verify
app.post('/api/admin/verify', (req, res) => {
    const { user, admin } = req.body;
    const users = readDB('users.json');
    
    const adminUser = users.find(u => u.user === admin);
    if (!adminUser || adminUser.role !== 'admin') {
        return res.json({ success: false, error: 'Нет прав' });
    }
    
    const target = users.find(u => u.user === user);
    if (target) {
        target.verified = !target.verified;
        writeDB('users.json', users);
        res.json({ success: true, verified: target.verified });
    } else {
        res.json({ success: false, error: 'Пользователь не найден' });
    }
});

// Админ: toggle ban
app.post('/api/admin/ban', (req, res) => {
    const { user, admin } = req.body;
    const users = readDB('users.json');
    
    const adminUser = users.find(u => u.user === admin);
    if (!adminUser || adminUser.role !== 'admin') {
        return res.json({ success: false, error: 'Нет прав' });
    }
    
    if (user === 'xewwnio') {
        return res.json({ success: false, error: 'Нельзя забанить админа' });
    }
    
    const target = users.find(u => u.user === user);
    if (target) {
        target.banned = !target.banned;
        writeDB('users.json', users);
        
        // Удаляем из онлайн
        if (target.banned) {
            const online = readDB('online.json');
            writeDB('online.json', online.filter(u => u !== user));
        }
        
        res.json({ success: true, banned: target.banned });
    } else {
        res.json({ success: false, error: 'Пользователь не найден' });
    }
});

// WebSocket
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'ping') {
                // Обновляем онлайн
                const online = readDB('online.json');
                if (!online.includes(data.user)) {
                    online.push(data.user);
                    writeDB('online.json', online);
                }
            }
        } catch (e) {}
    });
});

// Запуск сервера
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📁 База данных в папке: ${DB_PATH}`);
});