const express = require('express');
const mysql = require('mysql');
const session = require('express-session');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const app = express();
const PORT = 3000;

// --- SECURITY GUIDELINES COMPLIANCE ---
// Session Secret Management
function getSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    console.warn("Generating ephemeral secret. Instance-isolated!");
    return crypto.randomBytes(32).toString('hex');
}

app.use(express.urlencoded({ extended: true })); 
app.use(express.json());

// Set EJS as the view engine
app.set('view engine', 'ejs');

app.use(session({
    secret: getSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 3600000
    }
}));

// Provide session state to all views so navbar logic works
app.use((req, res, next) => {
    res.locals.role = req.session.role || null;
    next();
});

// TODO(security): It is highly recommended to use environment variables for DB credentials.
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'c237-leonard-mysql.mysql.database.azure.com',
    user: process.env.DB_USER || 'c237_023',
    password: process.env.DB_PASSWORD || 'c237023@2026!',
    database: process.env.DB_NAME || 'c237_023_team1_petcenter',
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err);
        return;
    }
    console.log('Connected to Azure MySQL database.');
});

// ==========================================
// ROUTES
// ==========================================

// Public Homepage
app.get('/', (req, res) => {
    res.render('index');
});

// Register Page
app.get('/register', (req, res) => {
    res.render('register');
});

// Register Logic
app.post('/register', async (req, res) => {
    const { name, phone, username, password, confirm_password } = req.body;

    if (password !== confirm_password) {
        return res.status(400).send("Passwords do not match. <a href='/register'>Try again</a>");
    }

    try {
        const password_hash = await bcrypt.hash(password, 10);
        const sql = "INSERT INTO users (name, phone, username, password_hash, role) VALUES (?, ?, ?, ?, 'customer')";
        
        db.query(sql, [name, phone, username, password_hash], (err, result) => {
            if (err) {
                console.error("Database error during registration:", err);
                return res.status(500).send("An internal server error occurred during registration. Please try again later.");
            }
            res.redirect('/login');
        });
    } catch (error) {
        console.error("Error during password hashing:", error);
        res.status(500).send("An internal server error occurred.");
    }
});

// Login Page
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

// Login Logic
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    db.query("SELECT * FROM users WHERE username = ?", [username], async (err, results) => {
        if (err) {
            console.error("Database error during login:", err);
            return res.status(500).send("An internal server error occurred.");
        }

        if (results.length === 0) {
            return res.render('login', { error: 'Invalid username or password.' });
        }

        const user = results[0];
        
        try {
            const match = await bcrypt.compare(password, user.password_hash);
            
            if (match) {
                req.session.regenerate((err) => {
                    if (err) return res.status(500).send("Session error");
                    
                    req.session.role = user.role;
                    if (user.role === 'staff') {
                        res.redirect('/staff-dashboard');
                    } else if (user.role === 'customer') {
                        res.redirect('/customer-dashboard');
                    } else {
                        res.redirect('/login');
                    }
                });
            } else {
                res.render('login', { error: 'Invalid username or password.' });
            }
        } catch (error) {
            console.error("Error during password comparison:", error);
            res.status(500).send("An internal server error occurred.");
        }
    });
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) console.error('Session destruction error:', err);
        res.redirect('/');
    });
});

// Customer Dashboard
app.get('/customer-dashboard', (req, res) => {
    if (req.session.role !== 'customer') {
        // TODO(security): Fail closed.
        return res.status(403).send("Forbidden. Customers only. <a href='/login'>Login</a>"); 
    }
    res.render('customer');
});

// Staff Dashboard
app.get('/staff-dashboard', (req, res) => {
    if (req.session.role !== 'staff') {
        // TODO(security): Fail closed.
        return res.status(403).send("Forbidden. Staff only. <a href='/login'>Login</a>"); 
    }
    res.render('staff');
});

// Start Server
// TODO(security): Listening on 127.0.0.1 for testing/development as per guidelines
app.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running on http://127.0.0.1:${PORT}`);
});