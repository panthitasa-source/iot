const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

// --- 1. เริ่มต้นระบบฐานข้อมูล ---
async function initDB() {
    try {
        db = await open({ filename: './database.db', driver: sqlite3.Database });
        
        // สร้าง Table ที่จำเป็น (เพิ่ม timestamp เพื่อรองรับระบบ History)
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

        // สร้าง Admin พื้นฐานถ้ายังไม่มี
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
            console.log(`📡 Simulating: ${temp}°C | ${time}`);
        } catch (e) {
            console.error('🔥 Sensor Error:', e);
        }
    }, 5000);
}

// --- 3. API สำหรับ ADMIN จัดการสมาชิก ---

// ดึงรายชื่อ User ทั้งหมด
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await db.all('SELECT id, username, role FROM users');
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: "ไม่สามารถดึงข้อมูลสมาชิกได้" });
    }
});

// ลบสมาชิก (ยกเว้น admin)
app.delete('/api/admin/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // เพิ่มความปลอดภัย: เช็คชื่อก่อนลบ ป้องกันการลบ Admin หลัก
        const userToDelete = await db.get('SELECT username FROM users WHERE id = ?', [id]);
        if (userToDelete && userToDelete.username === 'admin') {
            return res.status(403).json({ error: "ไม่สามารถลบผู้ดูแลระบบหลักได้" });
        }
        
        await db.run('DELETE FROM users WHERE id = ?', [id]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ error: "ไม่สามารถลบสมาชิกได้" });
    }
});

// เปลี่ยนบทบาท (User <-> Admin)
app.put('/api/admin/users/role', async (req, res) => {
    const { id, newRole } = req.body;
    try {
        await db.run('UPDATE users SET role = ? WHERE id = ?', [newRole, id]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ error: "ไม่สามารถอัปเดตบทบาทได้" });
    }
});

// --- 4. API สำหรับ Authentication & Profile ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        await db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, password, 'user']);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(400).json({ status: 'error', message: 'ชื่อผู้ใช้นี้มีคนใช้แล้ว' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
        if (user) res.json({ status: 'ok', role: user.role, user: user.username });
        else res.status(401).json({ status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านผิด' });
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

// --- 5. API สำหรับข้อมูลเซนเซอร์ (Real-time & History) ---

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
        res.status(500).json({ error: "ฐานข้อมูลขัดข้อง: " + e.message });
    }
});

// --- 6. เริ่มการทำงาน Server ---
app.get('/', (req, res) => res.redirect('/login.html'));

initDB(); // เรียกใช้ฐานข้อมูล

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 Server is running!
    📡 URL: http://localhost:${PORT}
    `);
});