const express = require('express');
const mysql = require('mysql');
const session = require('express-session');
const crypto = require('crypto');

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
    // Dummy registration logic for the skeleton
    // TODO(security): Implement parameterized queries and password hashing (e.g. Argon2)
    console.log("Dummy registration submitted");
    res.redirect('/login');
});

// Login Page
app.get('/login', (req, res) => {
    res.render('login');
});

// Login Logic
app.post('/login', async (req, res) => {
    // Dummy logic for the skeleton
    // TODO(security): Implement real authentication with parameterized queries and password hashing
    const username = req.body.username || '';
    const password = req.body.password || '';
    const role = req.body.role || '';
    
    // Regenerate session to prevent session fixation attacks
    req.session.regenerate((err) => {
        if (err) return res.status(500).send("Session error");
        
        if (role === 'staff' && username === 'staff' && password === 'test') {
            req.session.role = 'staff';
            res.redirect('/staff-dashboard');
        } else if (role === 'customer' && username === 'customer' && password === 'test') {
            req.session.role = 'customer';
            res.redirect('/customer-dashboard');
        } else {
            // If credentials fail, redirect back to /login
            res.redirect('/login');
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