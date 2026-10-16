const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In-memory storage (replace with a database for production)
const users = {};          // { username: { username, email, phone, password, avatar, size } }
const sockets = {};        // { username: socketId }

// ---------- AUTH ROUTES ----------
app.post('/api/signup', async (req, res) => {
    const { username, email, phone, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (users[username]) {
        return res.status(400).json({ error: 'Username already taken.' });
    }
    const existingByEmail = Object.values(users).find(u => u.email === email);
    if (existingByEmail) {
        return res.status(400).json({ error: 'Email already registered.' });
    }
    // After 2 accounts, phone is required
    const userCount = Object.keys(users).length;
    if (userCount >= 2 && !phone) {
        return res.status(400).json({ error: 'Phone number is required after 2 accounts.' });
    }
    const hashed = await bcrypt.hash(password, 10);
    users[username] = {
        username,
        email,
        phone: phone || '',
        password: hashed,
        avatar: null,
        size: 96,
    };
    const token = jwt.sign({ username }, 'secret-key-change-me');
    res.json({ token, username, email, phone: phone || '', avatar: null, size: 96 });
});

app.post('/api/login', async (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
        return res.status(400).json({ error: 'Missing credentials.' });
    }
    let user = users[identifier];
    if (!user) {
        user = Object.values(users).find(u => u.email === identifier);
    }
    if (!user) {
        return res.status(400).json({ error: 'Invalid credentials.' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
        return res.status(400).json({ error: 'Invalid credentials.' });
    }
    const token = jwt.sign({ username: user.username }, 'secret-key-change-me');
    res.json({
        token,
        username: user.username,
        email: user.email,
        phone: user.phone || '',
        avatar: user.avatar || null,
        size: user.size || 96,
    });
});

app.put('/api/profile', (req, res) => {
    const { username, newUsername, avatar, size } = req.body;
    if (!username || !users[username]) {
        return res.status(400).json({ error: 'User not found.' });
    }
    if (newUsername && newUsername !== username) {
        if (users[newUsername]) {
            return res.status(400).json({ error: 'New username already taken.' });
        }
        const user = users[username];
        delete users[username];
        user.username = newUsername;
        users[newUsername] = user;
        // Update socket mapping
        if (sockets[username]) {
            sockets[newUsername] = sockets[username];
            delete sockets[username];
        }
    }
    const target = users[newUsername || username];
    if (avatar !== undefined) target.avatar = avatar;
    if (size !== undefined) target.size = size;
    res.json({ success: true, username: target.username });
});

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('register', (username) => {
        if (!users[username]) return;
        sockets[username] = socket.id;
        socket.username = username;
        // Broadcast updated user list (excluding passwords)
        broadcastUsers();
        // Notify others of online status
        socket.broadcast.emit('user status', { username, online: true });
    });

    socket.on('private message', ({ to, text, time }) => {
        const from = socket.username;
        if (!from || !users[to]) return;
        const targetSocketId = sockets[to];
        if (targetSocketId) {
            io.to(targetSocketId).emit('private message', { from, text, time });
        }
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            delete sockets[socket.username];
            broadcastUsers();
            socket.broadcast.emit('user status', { username: socket.username, online: false });
        }
    });
});

function broadcastUsers() {
    const list = Object.values(users).map(u => ({
        username: u.username,
        avatar: u.avatar || null,
        size: u.size || 96,
        online: !!sockets[u.username],
    }));
    io.emit('users', list);
}

// Serve static frontend (optional)
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`KK Chatter server running on port ${PORT}`);
});
