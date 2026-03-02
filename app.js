const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

// --- ฟังก์ชันสุ่มข้อมูลเซนเซอร์ (Simulation) ---
// จะทำการสุ่มค่าทุกๆ 3 วินาที เพื่อให้มีข้อมูลในกราฟตลอดเวลา
function startSimulateSensors() {
    setInterval(async () => {
        if (!db) return;
        
        const temp = (Math.random() * (35 - 25) + 25).toFixed(2); // สุ่มอุณหภูมิ 25-35 °C
        const humi = (Math.random() * (70 - 40) + 40).toFixed(2); // สุ่มความชื้น 40-70 %
        const time = new Date().toLocaleTimeString('th-TH', { hour12: false });

        try {
            await db.run('INSERT INTO sensors (temp, humi, time) VALUES (?, ?, ?)', [temp, humi, time]);
            
            // รักษาขนาดฐานข้อมูล: เก็บไว้แค่ 100 แถวล่าสุด
            await db.run('DELETE FROM sensors WHERE id NOT IN (SELECT id FROM sensors ORDER BY id DESC LIMIT 100)');
            
            console.log(`📡 Sensor Update: ${temp}°C, ${humi}% at ${time}`);
        } catch (e) {
            console.error('🔥 Sensor Error:', e);
        }
    }, 3000); 
}

// --- เริ่มต้นระบบฐานข้อมูล ---
async function initDB() {
    db = await open({ filename: './database.db', driver: sqlite3.Database });
    
    // สร้างตารางข้อมูลสมาชิก และตารางเก็บค่าเซนเซอร์
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT);
        CREATE TABLE IF NOT EXISTS sensors (id INTEGER PRIMARY KEY AUTOINCREMENT, temp REAL, humi REAL, time TEXT);
    `);

    // สร้าง User Admin เริ่มต้น (Username: admin / Password: 123)
    const admin = await db.get('SELECT * FROM users WHERE username = "admin"');
    if (!admin) {
        await db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', ['admin', '123', 'admin']);
    }

    console.log("✅ Database Ready");
    startSimulateSensors(); // เริ่มระบบสุ่มข้อมูล
}

initDB();

// --- API สำหรับสมาชิก (Login / Register) ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        await db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, password, 'user']);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(400).json({ status: 'error', message: 'ชื่อผู้ใช้นี้อาจมีคนใช้แล้ว' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
    if (user) {
        res.json({ status: 'ok', role: user.role, user: user.username });
    } else {
        res.status(401).json({ status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
});

// --- API สำหรับจัดการข้อมูลส่วนตัว (Profile) ---

app.get('/api/me', async (req, res) => {
    const username = req.query.username;
    const user = await db.get('SELECT username, password FROM users WHERE username = ?', [username]);
    if (user) res.json(user);
    else res.status(404).json({ error: 'ไม่พบผู้ใช้' });
});

app.put('/api/users/update', async (req, res) => {
    const { oldUsername, newUsername, newPassword } = req.body;
    try {
        await db.run('UPDATE users SET username = ?, password = ? WHERE username = ?', [newUsername, newPassword, oldUsername]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(400).json({ status: 'error', message: 'ชื่อผู้ใช้นี้อาจมีคนใช้แล้ว' });
    }
});

// --- API สำหรับดึงข้อมูลกราฟและเซนเซอร์ ---

app.get('/api/sensors', async (req, res) => {
    try {
        // ดึง 20 ข้อมูลล่าสุดมาแสดงในกราฟ
        const logs = await db.all('SELECT * FROM sensors ORDER BY id DESC LIMIT 20');
        // คำนวณค่าทางสถิติ (Max, Min, Avg)
        const stats = await db.get(`
            SELECT MAX(temp) as maxT, MIN(temp) as minT, AVG(temp) as avgT 
            FROM (SELECT temp FROM sensors ORDER BY id DESC LIMIT 20)
        `);
        res.json({ logs: logs.reverse(), stats }); // ส่งแบบ reverse เพื่อให้กราฟเรียงจากซ้ายไปขวา
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- การตั้งค่า Port และหน้าแรก ---

app.get('/', (req, res) => {
    res.redirect('/login.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});