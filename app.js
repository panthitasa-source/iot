const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

// --- [ใหม่] ส่วนควบคุมอุปกรณ์ (IoT Control State) ---
// สถานะนี้จะถูกเก็บไว้ใน Memory (ถ้า Restart Server ค่าจะกลับเป็น OFF)
let deviceStatus = {
    lamp: "OFF",
    pump: "OFF"
};

// --- 1. เริ่มต้นระบบฐานข้อมูล ---
async function initDB() {
    try {
        db = await open({ filename: './database.db', driver: sqlite3.Database });
        
        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                username TEXT UNIQUE, 
                password TEXT, 
                role TEXT
            );
            CREATE TABLE IF NOT EXISTS sensors (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                temp REAL, 
                humi REAL, 
                time TEXT, 
                timestamp TEXT
            );
        `);

        const admin = await db.get('SELECT * FROM users WHERE username = "admin"');
        if (!admin) {
            await db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', ['admin', '123', 'admin']);
        }

        console.log("✅ Database & IoT System Ready");
        startSimulateSensors();
    } catch (err) {
        console.error("❌ DB Init Error:", err);
    }
}

// --- 2. ฟังก์ชันสุ่มข้อมูลเซนเซอร์ (Simulation) ---
function startSimulateSensors() {
    setInterval(async () => {
        if (!db) return;
        
        const temp = (Math.random() * (35 - 25) + 25).toFixed(2);
        const humi = (Math.random() * (70 - 40) + 40).toFixed(2);
        const now = new Date();
        const time = now.toLocaleTimeString('th-TH', { hour12: false });
        const timestamp = now.toISOString(); 

        try {
            await db.run(
                'INSERT INTO sensors (temp, humi, time, timestamp) VALUES (?, ?, ?, ?)', 
                [temp, humi, time, timestamp]
            );
            // console.log(`📡 Simulating: ${temp}°C | ${time}`); // ปิดไว้เพื่อให้ Terminal ไม่รก
        } catch (e) {
            console.error('🔥 Sensor Error:', e);
        }
    }, 5000);
}

// --- 3. API สำหรับควบคุมอุปกรณ์ (IoT Control API) ---

// ดึงสถานะปัจจุบัน (ใช้ทั้งหน้าเว็บ และให้อุปกรณ์ IoT มาดึงค่าไปใช้)
app.get('/api/control/status', (req, res) => {
    res.json(deviceStatus);
});

// รับคำสั่งจากหน้า Dashboard เพื่อเปลี่ยนสถานะ
app.post('/api/control/update', (req, res) => {
    const { device, status } = req.body; // รับค่า { device: "lamp", status: "ON" }
    
    if (deviceStatus.hasOwnProperty(device)) {
        deviceStatus[device] = status;
        console.log(`🔌 [CONTROL] ${device.toUpperCase()} set to ${status}`);
        res.json({ status: 'ok', device, newState: status });
    } else {
        res.status(400).json({ error: "Device not found" });
    }
});

// --- 4. API สำหรับ ADMIN จัดการสมาชิก ---

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await db.all('SELECT id, username, role FROM users');
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: "Error fetching users" });
    }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const userToDelete = await db.get('SELECT username FROM users WHERE id = ?', [id]);
        if (userToDelete && userToDelete.username === 'admin') {
            return res.status(403).json({ error: "Cannot delete master admin" });
        }
        await db.run('DELETE FROM users WHERE id = ?', [id]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ error: "Error deleting user" });
    }
});

app.put('/api/admin/users/role', async (req, res) => {
    const { id, newRole } = req.body;
    try {
        await db.run('UPDATE users SET role = ? WHERE id = ?', [newRole, id]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ error: "Error updating role" });
    }
});

// --- 5. API สำหรับ Authentication & Profile ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        await db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, password, 'user']);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(400).json({ status: 'error', message: 'User already exists' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
        if (user) res.json({ status: 'ok', role: user.role, user: user.username });
        else res.status(401).json({ status: 'error', message: 'Invalid credentials' });
    } catch (e) {
        res.status(500).json({ status: 'error' });
    }
});

app.get('/api/me', async (req, res) => {
    try {
        const user = await db.get('SELECT username, password FROM users WHERE username = ?', [req.query.username]);
        if (user) res.json(user);
        else res.status(404).send();
    } catch (e) { res.status(500).send(); }
});

app.put('/api/users/update', async (req, res) => {
    const { oldUsername, newUsername, newPassword } = req.body;
    try {
        await db.run('UPDATE users SET username = ?, password = ? WHERE username = ?', [newUsername, newPassword, oldUsername]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(400).json({ status: 'error' });
    }
});

// --- 6. API สำหรับข้อมูลเซนเซอร์ (Real-time & History) ---

app.get('/api/sensors', async (req, res) => {
    try {
        const logs = await db.all('SELECT * FROM sensors ORDER BY id DESC LIMIT 20');
        const stats = await db.get(`
            SELECT MAX(temp) as maxT, MIN(temp) as minT, AVG(temp) as avgT 
            FROM (SELECT temp FROM sensors ORDER BY id DESC LIMIT 20)
        `);
        res.json({ logs: logs.reverse(), stats });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/sensors/history', async (req, res) => {
    const { range, start, end } = req.query;
    let query = 'SELECT * FROM sensors';
    let params = [];

    try {
        if (range === 'day') {
            query += " WHERE date(timestamp, 'localtime') = date('now', 'localtime')";
        } else if (range === 'month') {
            query += " WHERE strftime('%Y-%m', timestamp, 'localtime') = strftime('%Y-%m', 'now', 'localtime')";
        } else if (range === 'year') {
            query += " WHERE strftime('%Y', timestamp, 'localtime') = strftime('%Y', 'now', 'localtime')";
        } else if (start && end) {
            query += ' WHERE date(timestamp, "localtime") BETWEEN ? AND ?';
            params.push(start, end);
        }

        const data = await db.all(`${query} ORDER BY id ASC`, params);
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: "Database error: " + e.message });
    }
});

// --- 7. เริ่มการทำงาน Server ---
app.get('/', (req, res) => res.redirect('/login.html'));

initDB();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 Server is running!
    📡 URL: http://localhost:${PORT}
    🔌 IoT Control Ready: Lamp & Pump
    `);
});