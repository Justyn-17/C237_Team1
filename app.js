const express = require('express');
const mysql = require('mysql');
const session = require('express-session');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Hosting platforms (Render, Heroku, Railway, …) terminate HTTPS at a proxy and
// forward plain HTTP to this app. Trusting the proxy lets Express read the
// X-Forwarded-Proto header, so it knows the original request was HTTPS and will
// actually set the secure session cookie. Without this, the cookie is dropped on
// the deployed site and login loops forever (works locally because there's no proxy).
app.set('trust proxy', 1);

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

// Serve uploaded pet photos from /public
app.use(express.static(path.join(__dirname, 'public')));

// Helper available to all views to normalize photo paths (avoid leaking absolute/stale filesystem paths)
app.locals.photoPath = function (photo) {
    if (!photo) return null;
    if (photo.includes('\\') || /^[A-Za-z]:/.test(photo)) {
        return `/uploads/pets/${path.basename(photo)}`;
    }
    return photo;
};

// Date/time formatting for views. The MySQL driver hands back DATE columns as JS
// Date objects, so rendering them directly prints the raw
// "Fri Jul 31 2026 00:00:00 GMT+0800 (...)" string. These helpers turn that into a
// readable label, using LOCAL date parts (not toISOString/UTC, which would be off
// by a day here since a DATE is parsed as local midnight).
const _WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// formatDate(value, { weekday: true }) -> "Mon, 20 Jul 2026"  (weekday defaults off)
app.locals.formatDate = function (value, opts) {
    if (value === null || value === undefined || value === '') return '—';

    let d;
    if (value instanceof Date) {
        d = value;
    } else {
        // Accept a "YYYY-MM-DD..." string and build a local calendar date from it,
        // so a plain date string is never shifted by a timezone.
        const ymd = String(value).slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
            const [y, m, day] = ymd.split('-').map(Number);
            d = new Date(y, m - 1, day);
        } else {
            d = new Date(value);
        }
    }

    if (isNaN(d.getTime())) return String(value);

    const base = `${d.getDate()} ${_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    return (opts && opts.weekday) ? `${_WEEKDAYS[d.getDay()]}, ${base}` : base;
};

// formatTime("14:00:00") -> "2:00 PM"
app.locals.formatTime = function (value) {
    if (value === null || value === undefined || value === '') return '—';
    const m = String(value).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return String(value);
    let hours = parseInt(m[1], 10);
    const minutes = m[2];
    const meridiem = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${meridiem}`;
};

// `pets.age` stores decimals (0.5 = 6 months), so show young pets in months
// rather than printing "0.5 yr".
app.locals.formatAge = function (age) {
    if (age === null || age === undefined || age === '') return '—';
    const years = Number(age);
    if (isNaN(years)) return '—';
    if (years >= 1) {
        // Drop a trailing ".0" so a 3-year-old reads "3 yr", not "3.0 yr"
        const shown = Number.isInteger(years) ? years : parseFloat(years.toFixed(1));
        return `${shown} yr`;
    }
    const months = Math.round(years * 12);
    return months < 1 ? '< 1 mo' : `${months} mo`;
};

// Inline paw placeholder shown when a pet has no photo. Kept as a data URI so the
// customer pages don't depend on an external image host.
app.locals.petPlaceholder =
    "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E" +
    "%3Crect%20width='100'%20height='100'%20fill='%23f1f5f9'/%3E%3Cg%20fill='%2394a3b8'%3E" +
    "%3Cellipse%20cx='50'%20cy='67'%20rx='20'%20ry='15'/%3E%3Ccircle%20cx='29'%20cy='45'%20r='8'/%3E" +
    "%3Ccircle%20cx='43'%20cy='34'%20r='8'/%3E%3Ccircle%20cx='58'%20cy='34'%20r='8'/%3E" +
    "%3Ccircle%20cx='72'%20cy='45'%20r='8'/%3E%3C/g%3E%3C/svg%3E";

// Multer config for pet photo uploads (used by /addpet)
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, 'public', 'uploads', 'pets');
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `pet-${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        cb(null, allowed.includes(file.mimetype));
    }
});

app.use(session({
    secret: getSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        // 'auto' (with trust proxy above) sends a secure cookie over HTTPS and a
        // normal one over plain HTTP. This is robust in both places: secure on the
        // deployed HTTPS site, still works on http://localhost — and never loops.
        secure: 'auto',
        sameSite: 'lax',
        maxAge: 3600000
    }
}));

// Provide session state to all views so navbar logic works
app.use((req, res, next) => {
    res.locals.role = req.session.role || null;
    // Used by the customer sidebar to greet the signed-in owner
    res.locals.username = req.session.username || null;
    res.locals.currentUser = { username: req.session.username, role: req.session.role };
    next();
});

// Role-based access control middleware
const requireRole = (role) => (req, res, next) => {
    if (role === 'staff' && req.session.role === 'admin') {
        return next();
    }
    if (req.session.role !== role) {
        return res.redirect('/login');
    }
    next();
};

// DB connection (Azure MySQL)
const dbConfig = {
    host: process.env.DB_HOST || 'c237-leonard-mysql.mysql.database.azure.com',
    user: process.env.DB_USER || 'c237_023',
    password: process.env.DB_PASSWORD || 'c237023@2026!',
    database: process.env.DB_NAME || 'c237_023_team1_petcenter',
    ssl: { rejectUnauthorized: false },
    dateString: true
};

let db;
const util = require('util');
let queryAsync;
let beginTransactionAsync;
let commitAsync;
let rollbackAsync;

function handleDisconnect() {
    db = mysql.createConnection(dbConfig);

    // Bind the async transaction helpers to the new connection
    queryAsync = util.promisify(db.query).bind(db);
    beginTransactionAsync = util.promisify(db.beginTransaction).bind(db);
    commitAsync = util.promisify(db.commit).bind(db);
    rollbackAsync = util.promisify(db.rollback).bind(db);

    db.connect((err) => {
        if (err) {
            console.error('Database connection failed:', err);
            setTimeout(handleDisconnect, 2000);
        } else {
            console.log('Connected to Azure MySQL database.');
        }
    });

    // Catch database errors to prevent the app from crashing on idle timeouts
    db.on('error', (err) => {
        console.error('Database connection error:', err);
        if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
            console.log("Database connection dropped. Auto-reconnecting...");
            handleDisconnect();
        } else {
            throw err;
        }
    });
}

handleDisconnect();

// --- MASTER RECOVERY CODES HELPER ---
function getSecureRandomChar() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let r = crypto.randomBytes(1)[0];
    while (r >= 252) r = crypto.randomBytes(1)[0];
    return chars[r % 36];
}

function generateSecureRecoveryCode() {
    let code = '';
    for (let i = 0; i < 12; i++) code += getSecureRandomChar();
    return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

// Global Session Invalidation Middleware
app.use((req, res, next) => {
    if (req.session && req.session.username) {
        db.query("SELECT status FROM users WHERE username = ?", [req.session.username], (err, results) => {
            if (err) {
                console.error("DB Error checking status:", err);
                return next();
            }
            if (results.length > 0 && results[0].status === 'deleted') {
                req.session.destroy(() => {
                    res.redirect('/login');
                });
            } else {
                next();
            }
        });
    } else {
        next();
    }
});

// ==========================================
// ROUTES
// ==========================================

// Smart Homepage: redirect logged-in users to their dashboard
app.get('/', (req, res) => {
    if (req.session.role === 'customer') {
        return res.redirect('/customer-dashboard');
    }
    if (req.session.role === 'staff') {
        return res.redirect('/staff-dashboard');
    }
    res.render('index');
});

// Services Information Page
app.get('/services', (req, res) => {
    res.render('services');
});

// Register Page
app.get('/register', (req, res) => {
    res.render('register');
});

// Register Logic (dummy)
app.post('/register', async (req, res) => {
    const { name, phone, username, password, confirm_password, securityQuestion, securityAnswer } = req.body;

    if (password !== confirm_password) {
        return res.status(400).send("Passwords do not match. <a href='/register'>Try again</a>");
    }

    try {
        const password_hash = await bcrypt.hash(password, 10);
        const security_answer_hash = securityAnswer ? await bcrypt.hash(securityAnswer, 10) : null;
        const sql = "INSERT INTO users (name, phone, username, password_hash, role, security_question, security_answer_hash) VALUES (?, ?, ?, ?, 'customer', ?, ?)";

        db.query(sql, [name, phone, username, password_hash, securityQuestion, security_answer_hash], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    if (err.sqlMessage && err.sqlMessage.includes('username')) {
                        return res.render('register', { errorMessage: "This username is already taken. Please choose another." });
                    } else if (err.sqlMessage && err.sqlMessage.includes('phone')) {
                        return res.render('register', { errorMessage: "This phone number is already registered." });
                    }
                }
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

// Login Logic (dummy)
app.post('/login', async (req, res) => {
    const { username, password, expectedRole } = req.body;

    db.query("SELECT * FROM users WHERE username = ?", [username], async (err, results) => {
        if (err) {
            console.error("Database error during login:", err);
            return res.status(500).send("An internal server error occurred.");
        }

        if (results.length === 0) {
            return res.render('login', { error: 'Invalid username or password.', activeTab: expectedRole });
        }

        const user = results[0];

        // Boundary Check: Ensure the user's role matches the portal they are trying to log in from
        if (expectedRole === 'staff' && (user.role !== 'staff' && user.role !== 'admin')) {
            return res.render('login', { error: 'Please use the correct portal for your account type.', activeTab: expectedRole });
        }
        if (expectedRole === 'customer' && user.role !== 'customer') {
            return res.render('login', { error: 'Please use the correct portal for your account type.', activeTab: expectedRole });
        }

        try {
            // Trim whitespace in case the user accidentally copied trailing spaces
            const cleanPassword = password.trim();
            const match = await bcrypt.compare(cleanPassword, user.password_hash);

            if (match) {
                // Return to ensure no further execution in this block
                return req.session.regenerate((err) => {
                    if (err) return res.status(500).send("Session error");

                    req.session.role = user.role;
                    req.session.username = user.username;
                    req.session.userId = user.id; // Helpful to store ID for DB queries

                    // Explicitly save the session before redirecting to prevent race conditions
                    req.session.save((saveErr) => {
                        if (saveErr) return res.status(500).send("Session error");

                        // Check boolean or MySQL tinyint (1)
                        if (user.requires_password_reset === true || user.requires_password_reset === 1) {
                            return res.redirect('/setup-password');
                        }

                        if (user.role === 'staff' || user.role === 'admin') {
                            return res.redirect('/staff-dashboard');
                        } else if (user.role === 'customer') {
                            return res.redirect('/customer-dashboard');
                        } else {
                            return res.redirect('/login');
                        }
                    });
                });
            } else {
                return res.render('login', { error: 'Invalid username or password.', activeTab: expectedRole });
            }
        } catch (error) {
            console.error("Error during password comparison:", error);
            return res.status(500).send("An internal server error occurred.");
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
app.get('/customer-dashboard', requireRole('customer'), (req, res) => {
    const sql = "SELECT * FROM pets WHERE owner_id = ?";

    db.query(sql, [req.session.userId], (err, results) => {
        if (err) {
            console.error("Error fetching pets:", err);
            return res.status(500).send("Database error");
        }

        results.forEach(p => {
            if (p.photo && (p.photo.includes('\\') || /^[A-Za-z]:/.test(p.photo))) {
                p.photo = `/uploads/pets/${path.basename(p.photo)}`;
            }
        });

        // Dashboard summary numbers. If either of these extra queries fails we still
        // render the page — the view falls back to "—" for any missing stat.
        const statsSql = `
            SELECT
                (SELECT COUNT(*) FROM pets WHERE owner_id = ?) AS petCount,
                (SELECT COUNT(*) FROM appointments
                    WHERE owner_id = ? AND status = 'booked' AND date >= CURDATE()) AS upcomingAppts,
                (SELECT COUNT(*) FROM reminders r
                    JOIN pets p ON r.pet_id = p.id
                    WHERE p.owner_id = ? AND r.status = 'Pending') AS pendingReminders
        `;

        const nextApptSql = `
            SELECT a.date, a.start_time, a.reason,
                   p.name AS pet_name, v.name AS vet_name
            FROM appointments a
            JOIN pets p ON a.pet_id = p.id
            LEFT JOIN users v ON a.vet_id = v.id
            WHERE a.owner_id = ? AND a.status = 'booked' AND a.date >= CURDATE()
            ORDER BY a.date, a.start_time
            LIMIT 1
        `;

        const userId = req.session.userId;

        db.query(statsSql, [userId, userId, userId], (statsErr, statsRows) => {
            if (statsErr) console.error("Error fetching dashboard stats:", statsErr);
            const stats = statsErr ? null : statsRows[0];

            db.query(nextApptSql, [userId], (apptErr, apptRows) => {
                if (apptErr) console.error("Error fetching next appointment:", apptErr);

                res.render('customer', {
                    pets: results,
                    stats,
                    nextAppointment: (!apptErr && apptRows.length) ? apptRows[0] : null
                });
            });
        });
    });
});

// Customer Profile
app.get('/profile', requireRole('customer'), (req, res) => {
    db.query("SELECT * FROM users WHERE id = ?", [req.session.userId], (err, results) => {
        if (err) {
            console.error("Error fetching user profile:", err);
            return res.status(500).send("Database error");
        }
        if (results.length === 0) {
            return res.status(404).send("User not found");
        }
        res.render('profile', { user: results[0] });
    });
});

app.post('/profile/update', requireRole('customer'), (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) {
        return res.status(400).send("Name and phone are required");
    }
    db.query("UPDATE users SET name = ?, phone = ? WHERE id = ?", [name, phone, req.session.userId], (err) => {
        if (err) {
            console.error("Error updating profile:", err);
            return res.status(500).send("Database error");
        }
        req.session.name = name;
        req.session.phone = phone;
        res.redirect('/profile');
    });
});

// Staff Profile
app.get('/staff/profile', requireRole('staff'), (req, res) => {
    db.query("SELECT * FROM users WHERE id = ?", [req.session.userId], (err, results) => {
        if (err) {
            console.error("Error fetching staff profile:", err);
            return res.status(500).send("Database error");
        }
        if (results.length === 0) {
            return res.status(404).send("User not found");
        }
        res.render('staff-profile', { user: results[0] });
    });
});

app.post('/staff/profile/update', requireRole('staff'), (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) {
        return res.status(400).send("Name and phone are required");
    }
    db.query("UPDATE users SET name = ?, phone = ? WHERE id = ?", [name, phone, req.session.userId], (err) => {
        if (err) {
            console.error("Error updating staff profile:", err);
            return res.status(500).send("Database error");
        }
        req.session.name = name;
        req.session.phone = phone;
        res.redirect('/staff/profile');
    });
});

// Staff Dashboard
app.get('/staff-dashboard', requireRole('staff'), (req, res) => {
    const isAdmin = req.session.username === 'admin';

    db.query("SELECT COUNT(*) AS count FROM pets", (err, petRows) => {
        if (err) {
            console.error("Error fetching pet count:", err);
            return res.status(500).send("Database error");
        }

        // Everyone sees clinic-wide numbers.
        const apptTodaySql = "SELECT COUNT(*) AS count FROM appointments WHERE date = CURDATE() AND status <> 'cancelled'";

        db.query(apptTodaySql, [], (err2, apptRows) => {
            if (err2) {
                console.error("Error fetching today's appointments:", err2);
                return res.status(500).send("Database error");
            }

            const monthlySql = "SELECT MONTH(date) AS month, COUNT(*) AS count FROM appointments WHERE status <> 'cancelled' GROUP BY MONTH(date)";

            db.query(monthlySql, [], (err4, monthlyRows) => {
                if (err4) {
                    console.error("Error fetching monthly appointments:", err4);
                    return res.status(500).send("Database error");
                }

                const monthlyAppointments = Array(12).fill(0);
                monthlyRows.forEach(row => {
                    if (row.month >= 1 && row.month <= 12) {
                        monthlyAppointments[row.month - 1] = row.count;
                    }
                });

                const speciesSql = "SELECT species, COUNT(*) AS count FROM pets GROUP BY species";
                db.query(speciesSql, (err5, speciesRows) => {
                    if (err5) {
                        console.error("Error fetching species breakdown:", err5);
                        return res.status(500).send("Database error");
                    }

                    const speciesMap = {};
                    speciesRows.forEach(row => {
                        let species = (row.species || "").trim().toLowerCase();
                        if (!species) {
                            species = "Unspecified";
                        } else {
                            if (species === 'dog') species = 'dogs';
                            if (species === 'cat') species = 'cats';
                            if (species === 'bird') species = 'birds';
                            if (species === 'rabbit') species = 'rabbits';
                            species = species.charAt(0).toUpperCase() + species.slice(1);
                        }
                        speciesMap[species] = (speciesMap[species] || 0) + row.count;
                    });

                    const speciesBreakdown = Object.keys(speciesMap).map(label => ({
                        label,
                        count: speciesMap[label]
                    })).sort((a, b) => b.count - a.count);

                    // Check remaining recovery codes if admin, and compute KPIs
                    if (isAdmin) {
                        db.query('SELECT COUNT(*) as count FROM recovery_codes WHERE user_id = (SELECT id FROM users WHERE username = ?) AND is_used = 0', ['admin'], (err6, codeRows) => {
                            let remainingCodes = 0;
                            if (!err6 && codeRows.length > 0) remainingCodes = codeRows[0].count;

                            // KPI 1: Revenue this calendar month (from paid invoices)
                            const kpiSql = `
                                SELECT
                                    COALESCE(SUM(CASE WHEN MONTH(paid_at) = MONTH(CURDATE()) AND YEAR(paid_at) = YEAR(CURDATE()) THEN amount ELSE 0 END), 0) AS revenueThisMonth,
                                    COUNT(CASE WHEN date BETWEEN DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) AND DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 6 DAY) THEN 1 END) AS apptThisWeek
                                FROM appointments
                                WHERE 1=1
                            `;
                            // Simpler parallel approach — two lightweight queries
                            const kpiRevSql = `SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE status='paid' AND MONTH(paid_at)=MONTH(CURDATE()) AND YEAR(paid_at)=YEAR(CURDATE())`;
                            const kpiWeekSql = `SELECT COUNT(*) AS cnt FROM appointments WHERE status<>'cancelled' AND date BETWEEN DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) AND DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 6 DAY)`;
                            const kpiPatSql = `SELECT COUNT(DISTINCT owner_id) AS cnt FROM appointments WHERE status<>'cancelled'`;
                            const kpiVetSql = `SELECT COUNT(*) AS cnt FROM users WHERE role='staff' AND status='active' AND username<>'admin'`;

                            db.query(kpiRevSql, [], (e1, r1) => {
                                db.query(kpiWeekSql, [], (e2, r2) => {
                                    db.query(kpiPatSql, [], (e3, r3) => {
                                        db.query(kpiVetSql, [], (e4, r4) => {
                                            res.render('staff', {
                                                totalPets: petRows[0].count,
                                                appointmentsToday: apptRows[0].count,
                                                monthlyAppointments: monthlyAppointments,
                                                speciesBreakdown: speciesBreakdown,
                                                remainingCodes: remainingCodes,
                                                kpiRevenue: (!e1 && r1.length) ? parseFloat(r1[0].total).toFixed(2) : '0.00',
                                                kpiWeekAppts: (!e2 && r2.length) ? r2[0].cnt : 0,
                                                kpiActivePatients: (!e3 && r3.length) ? r3[0].cnt : 0,
                                                kpiVetsOnDuty: (!e4 && r4.length) ? r4[0].cnt : 0
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    } else {
                        res.render('staff', {
                            totalPets: petRows[0].count,
                            appointmentsToday: apptRows[0].count,
                            monthlyAppointments: monthlyAppointments,
                            speciesBreakdown: speciesBreakdown,
                            remainingCodes: null
                        });
                    }
                });
            });
        });
    });
});

// ==========================================
// API: Analytics — Real-time KPIs
// GET /api/analytics/kpis
// Returns revenue, weekly appointments, active patients, and vets on duty.
// ==========================================
app.get('/api/analytics/kpis', requireRole('staff'), async (req, res) => {
    try {
        const kpiRevSql = `SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE status='paid' AND MONTH(paid_at)=MONTH(CURDATE()) AND YEAR(paid_at)=YEAR(CURDATE())`;
        const kpiWeekSql = `SELECT COUNT(*) AS cnt FROM appointments WHERE status<>'cancelled' AND date BETWEEN DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) AND DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 6 DAY)`;
        const kpiPatSql = `SELECT COUNT(DISTINCT owner_id) AS cnt FROM appointments WHERE status<>'cancelled'`;
        const kpiVetSql = `SELECT COUNT(*) AS cnt FROM users WHERE role='staff' AND status='active' AND username<>'admin'`;

        const queryAsync = (sql) => new Promise((resolve, reject) => {
            db.query(sql, [], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        const [r1, r2, r3, r4] = await Promise.all([
            queryAsync(kpiRevSql),
            queryAsync(kpiWeekSql),
            queryAsync(kpiPatSql),
            queryAsync(kpiVetSql)
        ]);

        res.json({
            revenue: (r1 && r1.length) ? parseFloat(r1[0].total) : 0,
            weekAppts: (r2 && r2.length) ? r2[0].cnt : 0,
            activePatients: (r3 && r3.length) ? r3[0].cnt : 0,
            vetsOnDuty: (r4 && r4.length) ? r4[0].cnt : 0
        });
    } catch (error) {
        console.error('Failed to fetch KPIs:', error);
        res.status(500).json({ error: 'Failed to fetch KPIs' });
    }
});

// ==========================================
// API: Analytics — Revenue by Invoice Category
// GET /api/analytics/revenue
// Returns { labels: [...], data: [...] } for the admin Revenue Doughnut chart.
// Revenue is sourced from paid invoices grouped by category.
// ==========================================
app.get('/api/analytics/revenue', requireRole('staff'), (req, res) => {
    const sql = `
        SELECT category AS label, COALESCE(SUM(amount), 0) AS total
        FROM invoices
        WHERE status = 'paid'
        GROUP BY category
        ORDER BY total DESC
    `;
    db.query(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching revenue analytics:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({
            labels: rows.map(r => r.label || 'Uncategorised'),
            data: rows.map(r => parseFloat(r.total) || 0)
        });
    });
});

// ==========================================
// API: Analytics — Staff Workload Distribution
// GET /api/analytics/workload
// Returns { labels: [...], data: [...] } for the admin Workload Bar chart.
// Counts active+completed appointments per vet (excludes system admin).
// ==========================================
app.get('/api/analytics/workload', requireRole('staff'), (req, res) => {
    const sql = `
        SELECT u.name AS label, COUNT(a.id) AS count
        FROM appointments a
        JOIN users u ON a.vet_id = u.id
        WHERE a.status IN ('booked', 'completed', 'waiting', 'in_consultation')
          AND u.username <> 'admin'
        GROUP BY a.vet_id, u.name
        ORDER BY count DESC
    `;
    db.query(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching workload analytics:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({
            labels: rows.map(r => r.label),
            data: rows.map(r => r.count)
        });
    });
});

// ==========================================
// API: Clinic-Wide Appointment Volume Chart
// GET /api/appointments/volume?timeframe=week|month|year|all-time
// ==========================================
app.get('/api/appointments/volume', requireRole('staff'), (req, res) => {
    const timeframe = (req.query.timeframe || 'all-time').toLowerCase();

    let sql, params = [];

    if (timeframe === 'week') {
        // Rolling 7-day window. DATE() strips the time component so today's
        // freshly-booked appointments are always included regardless of the
        // exact time the query runs.
        sql = `
            SELECT DATE(date) AS period, COUNT(*) AS count
            FROM appointments
            WHERE DATE(date) >= CURDATE() - INTERVAL 6 DAY
              AND status <> 'cancelled'
            GROUP BY DATE(date)
            ORDER BY DATE(date)
        `;
    } else if (timeframe === 'month') {
        // Current calendar month grouped by day-of-month
        sql = `
            SELECT DAY(date) AS period, COUNT(*) AS count
            FROM appointments
            WHERE YEAR(date) = YEAR(CURDATE())
              AND MONTH(date) = MONTH(CURDATE())
              AND status <> 'cancelled'
            GROUP BY DAY(date)
            ORDER BY DAY(date)
        `;
    } else if (timeframe === 'year') {
        // Current year grouped by month number (1–12)
        sql = `
            SELECT MONTH(date) AS period, COUNT(*) AS count
            FROM appointments
            WHERE YEAR(date) = YEAR(CURDATE())
              AND status <> 'cancelled'
            GROUP BY MONTH(date)
            ORDER BY MONTH(date)
        `;
    } else {
        // All-time grouped by year+month
        sql = `
            SELECT DATE_FORMAT(date, '%Y-%m') AS period, COUNT(*) AS count
            FROM appointments
            WHERE status <> 'cancelled'
              AND date IS NOT NULL
            GROUP BY DATE_FORMAT(date, '%Y-%m')
            ORDER BY DATE_FORMAT(date, '%Y-%m')
        `;
    }

    db.query(sql, params, (err, rows) => {
        if (err) {
            console.error('Error fetching appointment volume:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        let labels = [];
        let data = [];

        if (timeframe === 'week') {
            // Normalise r.period to a YYYY-MM-DD string.
            // The mysql npm package returns DATE() computed columns as JS Date
            // objects (even with dateString:true), so we cannot use them directly
            // as map keys — their toString() never matches an ISO string.
            // We also build the loop key from LOCAL date parts (not toISOString)
            // to avoid UTC-offset issues (e.g. toISOString returns yesterday
            // before 08:00 in UTC+8).
            const toLocalISO = (d) => {
                const y = d.getFullYear();
                const mo = String(d.getMonth() + 1).padStart(2, '0');
                const dy = String(d.getDate()).padStart(2, '0');
                return `${y}-${mo}-${dy}`;
            };

            const map = {};
            rows.forEach(r => {
                // Coerce to a reliable YYYY-MM-DD string whether r.period is a
                // Date object or already a 'YYYY-MM-DD' string.
                const key = (r.period instanceof Date)
                    ? toLocalISO(r.period)
                    : String(r.period).slice(0, 10);
                map[key] = r.count;
            });

            // Build exactly 7 entries oldest-to-newest (AC3), zero-filling gaps (AC2)
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const iso = toLocalISO(d);
                const label = `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
                labels.push(label);
                data.push(map[iso] || 0);
            }
        } else if (timeframe === 'month') {
            // Days 1..N of the current month; fill gaps with 0
            const now = new Date();
            const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            const map = {};
            rows.forEach(r => { map[Number(r.period)] = r.count; });
            for (let d = 1; d <= daysInMonth; d++) {
                labels.push(String(d));
                data.push(map[d] || 0);
            }
        } else if (timeframe === 'year') {
            // Jan–Dec; fill months with no data as 0
            const map = {};
            rows.forEach(r => { map[Number(r.period)] = r.count; });
            for (let m = 1; m <= 12; m++) {
                labels.push(MONTH_NAMES[m - 1]);
                data.push(map[m] || 0);
            }
        } else {
            // All-time: build readable "Mon YYYY" labels from YYYY-MM keys
            rows.forEach(r => {
                const [y, m] = String(r.period).split('-');
                labels.push(`${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`);
                data.push(r.count);
            });
        }

        res.json({ labels, data });
    });
});

// ==========================================
// API: Per-Vet Appointment Volume Chart
// GET /api/vet/appointments/volume?timeframe=week|month|year|all-time
// ==========================================
app.get('/api/vet/appointments/volume', requireRole('staff'), (req, res) => {
    const timeframe = (req.query.timeframe || 'all-time').toLowerCase();
    const vetId = req.session.userId;

    let sql, params = [];

    if (timeframe === 'week') {
        // Rolling 7-day window — DATE() strips time-of-day so freshly booked
        // appointments are included immediately.
        sql = `
            SELECT DATE(date) AS period, COUNT(*) AS count
            FROM appointments
            WHERE DATE(date) >= CURDATE() - INTERVAL 6 DAY
              AND status <> 'cancelled'
              AND vet_id = ?
            GROUP BY DATE(date)
            ORDER BY DATE(date)
        `;
        params = [vetId];
    } else if (timeframe === 'month') {
        sql = `
            SELECT DAY(date) AS period, COUNT(*) AS count
            FROM appointments
            WHERE YEAR(date) = YEAR(CURDATE())
              AND MONTH(date) = MONTH(CURDATE())
              AND status <> 'cancelled'
              AND vet_id = ?
            GROUP BY DAY(date)
            ORDER BY DAY(date)
        `;
        params = [vetId];
    } else if (timeframe === 'year') {
        sql = `
            SELECT MONTH(date) AS period, COUNT(*) AS count
            FROM appointments
            WHERE YEAR(date) = YEAR(CURDATE())
              AND status <> 'cancelled'
              AND vet_id = ?
            GROUP BY MONTH(date)
            ORDER BY MONTH(date)
        `;
        params = [vetId];
    } else {
        sql = `
            SELECT DATE_FORMAT(date, '%Y-%m') AS period, COUNT(*) AS count
            FROM appointments
            WHERE status <> 'cancelled'
              AND date IS NOT NULL
              AND vet_id = ?
            GROUP BY DATE_FORMAT(date, '%Y-%m')
            ORDER BY DATE_FORMAT(date, '%Y-%m')
        `;
        params = [vetId];
    }

    db.query(sql, params, (err, rows) => {
        if (err) {
            console.error('Error fetching vet appointment volume:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        let labels = [];
        let data = [];

        if (timeframe === 'week') {
            // Same toLocalISO helper: avoids JS Date object key mismatch and
            // UTC-offset day-boundary errors from toISOString().
            const toLocalISO = (d) => {
                const y = d.getFullYear();
                const mo = String(d.getMonth() + 1).padStart(2, '0');
                const dy = String(d.getDate()).padStart(2, '0');
                return `${y}-${mo}-${dy}`;
            };

            const map = {};
            rows.forEach(r => {
                const key = (r.period instanceof Date)
                    ? toLocalISO(r.period)
                    : String(r.period).slice(0, 10);
                map[key] = r.count;
            });

            // Exactly 7 entries oldest-to-newest, zero-filled
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const iso = toLocalISO(d);
                const label = `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
                labels.push(label);
                data.push(map[iso] || 0);
            }
        } else if (timeframe === 'month') {
            const now = new Date();
            const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            const map = {};
            rows.forEach(r => { map[Number(r.period)] = r.count; });
            for (let d = 1; d <= daysInMonth; d++) {
                labels.push(String(d));
                data.push(map[d] || 0);
            }
        } else if (timeframe === 'year') {
            const map = {};
            rows.forEach(r => { map[Number(r.period)] = r.count; });
            for (let m = 1; m <= 12; m++) {
                labels.push(MONTH_NAMES[m - 1]);
                data.push(map[m] || 0);
            }
        } else {
            rows.forEach(r => {
                const [y, m] = String(r.period).split('-');
                labels.push(`${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`);
                data.push(r.count);
            });
        }

        res.json({ labels, data });
    });
});

// API: Vet Queue by Date
app.get('/api/vet/queue', requireRole('staff'), (req, res) => {
    if (req.session.username === 'admin') return res.status(403).json({ error: 'Admins do not have a queue.' });
    const vetId = req.session.userId;
    const dateStr = req.query.date;

    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).json({ error: 'Valid date is required (YYYY-MM-DD).' });
    }

    db.query(
        `SELECT a.id, a.date, a.start_time, a.end_time, a.reason, a.status, a.clinical_status,
                p.name AS pet_name, o.name AS owner_name
         FROM appointments a
         LEFT JOIN pets p ON a.pet_id = p.id
         LEFT JOIN users o ON a.owner_id = o.id
         WHERE a.vet_id = ? AND a.date = ?
         ORDER BY a.start_time`,
        [vetId, dateStr],
        (err, rows) => {
            if (err) {
                console.error("Error fetching vet queue:", err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json({ queue: rows });
        }
    );
});

// ==========================================
// ISOLATED VET DASHBOARD ENDPOINTS
// ==========================================

// Vet API: Log or Update Vitals for Appointment
app.post('/vet/api/appointments/:id/vitals', requireRole('staff'), (req, res) => {
    const { weight, temperature, observations } = req.body;
    db.query(
        "UPDATE appointments SET vitals_weight = ?, vitals_temperature = ?, vitals_observations = ? WHERE id = ? AND vet_id = ?",
        [weight || null, temperature || null, observations || null, req.params.id, req.session.userId],
        (err, result) => {
            if (err) {
                console.error("Error saving vitals:", err);
                return res.status(500).json({ error: 'Database error' });
            }
            console.log("VITALS POST:", { id: req.params.id, body: req.body, vet_id: req.session.userId, affectedRows: result.affectedRows });
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Appointment not found or not yours.' });
            }
            res.json({ success: true });
        }
    );
});

// Vet API: Get Vitals for Appointment
app.get('/vet/api/appointments/:id/vitals', requireRole('staff'), (req, res) => {
    db.query(
        "SELECT vitals_weight AS weight, vitals_temperature AS temperature, vitals_observations AS observations FROM appointments WHERE id = ? AND vet_id = ?",
        [req.params.id, req.session.userId],
        (err, rows) => {
            if (err) {
                console.error("Error fetching vitals:", err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json(rows[0] || {});
        }
    );
});

// GLOBAL API: Update Appointment Status
app.patch('/api/appointments/:id/status', requireRole('staff'), (req, res) => {
    const { status } = req.body;
    db.query(
        "UPDATE appointments SET status = ? WHERE id = ?",
        [status, req.params.id],
        (err, result) => {
            if (err) {
                console.error("Error updating status:", err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json({ success: true });
        }
    );
});

// Vet API: Update Appointment Clinical Status (Isolated with Tasks)
app.patch('/vet/api/appointments/:id/clinical-status', requireRole('staff'), (req, res) => {
    const { status } = req.body;
    const apptId = req.params.id;
    const vetIdFilter = req.session.userId;

    if (status === 'labs_pending') {
        db.beginTransaction(err => {
            if (err) {
                console.error("Transaction start error:", err);
                return res.status(500).json({ error: 'Database error' });
            }

            db.query("UPDATE appointments SET clinical_status = ? WHERE id = ? AND vet_id = ?", [status, apptId, vetIdFilter], (err, result) => {
                if (err) {
                    return db.rollback(() => {
                        console.error("Error updating status:", err);
                        res.status(500).json({ error: 'Database error' });
                    });
                }

                db.query(
                    "SELECT p.name AS pet_name, a.vet_id FROM appointments a JOIN pets p ON a.pet_id = p.id WHERE a.id = ?",
                    [apptId],
                    (err2, rows) => {
                        if (err2 || rows.length === 0) {
                            return db.rollback(() => {
                                console.error("Error fetching patient details:", err2);
                                res.status(500).json({ error: 'Database error' });
                            });
                        }

                        const petName = rows[0].pet_name;
                        const vetId = rows[0].vet_id;
                        const taskDesc = `Review lab results for ${petName}`;

                        db.query(
                            "INSERT INTO tasks (assigned_to, description, status, appointment_id) VALUES (?, ?, 'incomplete', ?)",
                            [vetId, taskDesc, apptId],
                            (err3, result3) => {
                                if (err3) {
                                    return db.rollback(() => {
                                        console.error("Error inserting task:", err3);
                                        res.status(500).json({ error: 'Database error' });
                                    });
                                }

                                db.commit(err4 => {
                                    if (err4) {
                                        return db.rollback(() => {
                                            console.error("Transaction commit error:", err4);
                                            res.status(500).json({ error: 'Database error' });
                                        });
                                    }
                                    res.json({
                                        success: true,
                                        taskGenerated: true,
                                        task: { id: result3.insertId, description: taskDesc, status: 'incomplete' }
                                    });
                                });
                            }
                        );
                    }
                );
            });
        });
    } else {
        db.query(
            "UPDATE appointments SET clinical_status = ? WHERE id = ? AND vet_id = ?",
            [status, apptId, vetIdFilter],
            (err, result) => {
                if (err) {
                    console.error("Error updating status:", err);
                    return res.status(500).json({ error: 'Database error' });
                }
                res.json({ success: true });
            }
        );
    }
});


// Vet: View Patient Medical Record
app.get('/vet/record/:id', requireRole('staff'), (req, res) => {
    const sql = `
        SELECT a.id, a.date, a.start_time, a.end_time, a.reason, a.status, a.clinical_status,
               a.vitals_weight, a.vitals_temperature, a.vitals_observations,
               p.name AS pet_name, p.species, p.breed, p.age,
               u.name AS owner_name,
               v.name AS vet_name
        FROM appointments a
        LEFT JOIN pets p ON a.pet_id = p.id
        LEFT JOIN users u ON a.owner_id = u.id
        LEFT JOIN users v ON a.vet_id = v.id
        WHERE a.id = ? AND a.vet_id = ?
    `;
    db.query(sql, [req.params.id, req.session.userId], (err, rows) => {
        if (err) {
            console.error("Error fetching appointment details:", err);
            return res.status(500).send("Database error");
        }
        if (rows.length === 0) return res.status(404).send("Appointment not found or unauthorized access.");

        // --- DEBUG LINE: Look at your IDE terminal when you refresh the page! ---
        console.log("DEBUG DATABASE ROW:", rows[0]);
        // ------------------------------------------------------------------------

        res.render('vet/patient-record', {
            appointment: rows[0],
            currentUser: { username: req.session.username, role: req.session.role }
        });
    });
});

// API: Complete Task
app.patch('/api/tasks/:id/complete', requireRole('staff'), (req, res) => {
    db.query(
        "UPDATE tasks SET status = 'complete' WHERE id = ? AND assigned_to = ?",
        [req.params.id, req.session.userId],
        (err, result) => {
            if (err) {
                console.error("Error completing task:", err);
                return res.status(500).json({ error: 'Database error' });
            }

            db.query(
                "UPDATE appointments SET clinical_status = NULL WHERE id = (SELECT appointment_id FROM tasks WHERE id = ?)",
                [req.params.id],
                (err2) => {
                    if (err2) console.error("Error clearing clinical_status:", err2);
                    res.json({ success: true });
                }
            );
        }
    );
});


// Vet Dashboard: a single vet's own patients and appointments
app.get('/staff/vet-dashboard', requireRole('staff'), (req, res) => {
    if (req.session.username === 'admin') return res.redirect('/staff-dashboard');
    const vetId = req.session.userId;

    db.query(
        "SELECT COUNT(DISTINCT pet_id) AS count FROM appointments WHERE vet_id = ?",
        [vetId],
        (err, patientRows) => {
            if (err) {
                console.error("Error fetching patient count:", err);
                return res.status(500).send("Database error");
            }

            db.query(
                "SELECT COUNT(*) AS count FROM appointments WHERE date = CURDATE() AND status <> 'cancelled' AND vet_id = ?",
                [vetId],
                (err2, apptRows) => {
                    if (err2) {
                        console.error("Error fetching today's appointments:", err2);
                        return res.status(500).send("Database error");
                    }

                    db.query(
                        `SELECT a.id, a.date, a.start_time, a.end_time, a.reason, a.status,
                                p.name AS pet_name, o.name AS owner_name
                         FROM appointments a
                         LEFT JOIN pets p ON a.pet_id = p.id
                         LEFT JOIN users o ON a.owner_id = o.id
                         WHERE a.vet_id = ?
                           AND a.date >= CURDATE()
                           AND a.status = 'booked'
                         ORDER BY a.date, a.start_time
                         LIMIT 10`,
                        [vetId],
                        (err3, apptListRows) => {
                            if (err3) {
                                console.error("Error fetching vet appointments:", err3);
                                return res.status(500).send("Database error");
                            }

                            const monthlySql = "SELECT MONTH(date) AS month, COUNT(*) AS count FROM appointments WHERE status <> 'cancelled' AND vet_id = ? GROUP BY MONTH(date)";
                            db.query(monthlySql, [vetId], (err4, monthlyRows) => {
                                if (err4) {
                                    console.error("Error fetching vet monthly appointments:", err4);
                                    return res.status(500).send("Database error");
                                }

                                const monthlyAppointments = Array(12).fill(0);
                                monthlyRows.forEach(row => {
                                    if (row.month >= 1 && row.month <= 12) {
                                        monthlyAppointments[row.month - 1] = row.count;
                                    }
                                });

                                const speciesSql = `SELECT p.species, COUNT(DISTINCT p.id) AS count
                                                    FROM pets p
                                                    JOIN appointments a ON a.pet_id = p.id
                                                    WHERE a.vet_id = ?
                                                    GROUP BY p.species`;
                                db.query(speciesSql, [vetId], (err5, speciesRows) => {
                                    if (err5) {
                                        console.error("Error fetching vet species breakdown:", err5);
                                        return res.status(500).send("Database error");
                                    }

                                    const speciesMap = {};
                                    speciesRows.forEach(row => {
                                        let species = (row.species || "").trim().toLowerCase();
                                        if (!species) {
                                            species = "Unspecified";
                                        } else {
                                            if (species === 'dog') species = 'dogs';
                                            if (species === 'cat') species = 'cats';
                                            if (species === 'bird') species = 'birds';
                                            if (species === 'rabbit') species = 'rabbits';
                                            species = species.charAt(0).toUpperCase() + species.slice(1);
                                        }
                                        speciesMap[species] = (speciesMap[species] || 0) + row.count;
                                    });

                                    const speciesBreakdown = Object.keys(speciesMap).map(label => ({
                                        label,
                                        count: speciesMap[label]
                                    })).sort((a, b) => b.count - a.count);

                                    // Today's patient queue: appointments for this vet today, ordered by time
                                    const queueSql = `
                                        SELECT a.id, a.start_time, a.reason, a.status,
                                               p.name AS pet_name, o.name AS owner_name
                                        FROM appointments a
                                        LEFT JOIN pets p ON a.pet_id = p.id
                                        LEFT JOIN users o ON a.owner_id = o.id
                                        WHERE a.vet_id = ? AND a.date = CURDATE() AND a.status <> 'cancelled'
                                        ORDER BY a.start_time
                                    `;
                                    db.query(queueSql, [vetId], (err6, queueRows) => {
                                        if (err6) {
                                            console.error("Error fetching today's queue:", err6);
                                            // Non-fatal: render with empty queue rather than 500
                                            queueRows = [];
                                        }

                                        db.query("SELECT id, description, status, appointment_id FROM tasks WHERE assigned_to = ? AND status = 'incomplete'", [vetId], (err7, taskRows) => {
                                            if (err7) {
                                                console.error("Error fetching tasks:", err7);
                                                taskRows = [];
                                            }

                                            res.render('vet_dashboard', {
                                                myPatients: patientRows[0].count,
                                                myAppointmentsToday: apptRows[0].count,
                                                myAppointments: apptListRows,
                                                monthlyAppointments: monthlyAppointments,
                                                speciesBreakdown: speciesBreakdown,
                                                todayQueue: queueRows,
                                                clinicalTasks: taskRows
                                            });
                                        });
                                    });
                                });
                            });
                        }
                    );
                }
            );
        }
    );
});

// Staff: View user directory
app.get('/user-directory', requireRole('staff'), (req, res) => {
    db.query("SELECT * FROM users", (err, results) => {
        if (err) {
            console.error("Error fetching users:", err);
            return res.status(500).send("Database error");
        }
        res.render('user-directory', {
            users: results,
            currentUser: { username: req.session.username, role: req.session.role },
            accessCode: null,
            newUsername: null,
            activeTab: req.query.tab
        });
    });
});

// Staff: View all pets (across every owner)
app.get('/staff/pets', requireRole('staff'), (req, res) => {
    // Search by pet or owner name, and optionally filter by species
    const search = (req.query.q || '').trim();
    const SPECIES = ['Dog', 'Cat', 'Bird', 'Rabbit'];
    const species = SPECIES.includes(req.query.species) ? req.query.species : '';

    const where = [];
    const params = [];

    if (search) {
        where.push('(p.name LIKE ? OR u.name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
    }
    if (species) {
        where.push('p.species = ?');
        params.push(species);
    }

    const sql = `
        SELECT p.*, u.name AS owner_name
        FROM pets p
        LEFT JOIN users u ON p.owner_id = u.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY p.name
    `;

    db.query(sql, params, (err, results) => {
        if (err) {
            console.error("Error fetching pets:", err);
            return res.status(500).send("Database error");
        }

        results.forEach(p => {
            if (p.photo && (p.photo.includes('\\') || /^[A-Za-z]:/.test(p.photo))) {
                p.photo = `/uploads/pets/${path.basename(p.photo)}`;
            }
        });

        res.render('staff-pets', {
            pets: results,
            search,
            species,
            speciesOptions: SPECIES
        });
    });
});

// Staff: View a specific pet + its care records (read-only)
app.get('/staff/pets/view/:id', requireRole('staff'), (req, res) => {
    const petId = req.params.id;
    const CARE_RECORD_TYPES = ['Feeding', 'Vaccination', 'Medication'];
    const typeFilter = CARE_RECORD_TYPES.includes(req.query.type) ? req.query.type : null;

    const petSql = `
        SELECT p.*, u.name AS owner_name
        FROM pets p
        LEFT JOIN users u ON p.owner_id = u.id
        WHERE p.id = ?
    `;

    db.query(petSql, [petId], (err, pets) => {
        if (err) {
            console.error("Error fetching pet:", err);
            return res.status(500).send("Database error");
        }
        if (pets.length === 0) {
            return res.status(404).send("Pet not found. <a href='/staff/pets'>Go back</a>");
        }

        const recordsSql = typeFilter
            ? "SELECT * FROM care_records WHERE pet_id = ? AND record_type = ? ORDER BY record_date DESC"
            : "SELECT * FROM care_records WHERE pet_id = ? ORDER BY record_date DESC";
        const recordParams = typeFilter ? [petId, typeFilter] : [petId];

        db.query(recordsSql, recordParams, (err, records) => {
            if (err) {
                console.error("Error fetching care records:", err);
                return res.status(500).send("Database error");
            }
            if (pets[0].photo && (pets[0].photo.includes('\\') || /^[A-Za-z]:/.test(pets[0].photo))) {
                pets[0].photo = `/uploads/pets/${path.basename(pets[0].photo)}`;
            }
            res.render('staff-viewpet', { pet: pets[0], records, typeFilter });
        });
    });
});

// Staff: Create user
app.post('/staff/create-user', requireRole('staff'), async (req, res) => {
    let { users } = req.body;

    if (!users) {
        return res.status(400).send("No users provided");
    }

    // Normalize users to array (body-parser might parse it as an object with numeric keys)
    if (!Array.isArray(users)) {
        users = Object.values(users);
    }

    const addedUsers = [];
    const failedUsers = [];

    try {
        for (const user of users) {
            const { name, username, phone } = user;
            if (!name || !username || !phone) {
                failedUsers.push({ username: username || 'Unknown', error: 'Missing name, username, or phone.' });
                continue;
            }

            try {
                const accessCode = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 char hex
                const salt = await bcrypt.genSalt(10);
                const hashedPassword = await bcrypt.hash(accessCode, salt);

                await new Promise((resolve, reject) => {
                    const sql = "INSERT INTO users (name, username, phone, password_hash, role, requires_password_reset) VALUES (?, ?, ?, ?, 'staff', true)";
                    db.query(sql, [name, username, phone, hashedPassword], (err, result) => {
                        if (err) return reject(err);
                        resolve(result);
                    });
                });

                addedUsers.push({ username, accessCode });
            } catch (err) {
                console.error("Database error during staff creation for user", username, ":", err);
                let errorMsg = "Database error";
                if (err.code === 'ER_DUP_ENTRY') {
                    errorMsg = "Username or phone already exists.";
                }
                failedUsers.push({ username, error: errorMsg });
            }
        }

        db.query("SELECT * FROM users", (err, results) => {
            if (err) {
                console.error("Error fetching users:", err);
                return res.status(500).send("Database error");
            }
            res.render('user-directory', { users: results, addedUsers, failedUsers });
        });

    } catch (error) {
        console.error("Critical error in staff bulk creation:", error);
        res.status(500).send("Internal server error");
    }
});

// Setup Password Routes
app.get('/setup-password', (req, res) => {
    if (!req.session.username) {
        return res.redirect('/login');
    }
    if (req.session.resetAuthorized) {
        return res.render('setup-password', { error: null });
    }
    db.query("SELECT requires_password_reset FROM users WHERE username = ?", [req.session.username], (err, results) => {
        if (err || results.length === 0 || !results[0].requires_password_reset) {
            return res.redirect('/');
        }
        res.render('setup-password', { error: null });
    });
});

app.post('/setup-password', async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { new_password, confirm_password, securityQuestion, securityAnswer } = req.body;
    if (new_password !== confirm_password) {
        return res.render('setup-password', { error: "Passwords do not match." });
    }
    if (new_password.length < 8) {
        return res.render('setup-password', { error: "Password must be at least 8 characters long." });
    }

    try {
        const password_hash = await bcrypt.hash(new_password, 10);
        const security_answer_hash = securityAnswer ? await bcrypt.hash(securityAnswer, 10) : null;

        let sql = "UPDATE users SET password_hash = ?, requires_password_reset = false, password_reset_requested = false WHERE username = ?";
        let params = [password_hash, req.session.username];

        if (securityQuestion && securityAnswer) {
            sql = "UPDATE users SET password_hash = ?, requires_password_reset = false, password_reset_requested = false, security_question = ?, security_answer_hash = ? WHERE username = ?";
            params = [password_hash, securityQuestion, security_answer_hash, req.session.username];
        }

        db.query(sql, params, (err, result) => {
            if (err) {
                console.error("Database error during password setup:", err);
                return res.status(500).send("Database error");
            }
            req.session.resetAuthorized = false; // clear reset authorization
            if (req.session.role === 'staff' || req.session.role === 'admin') {
                res.redirect('/staff-dashboard');
            } else {
                res.redirect('/customer-dashboard');
            }
        });
    } catch (error) {
        console.error("Error hashing password:", error);
        res.status(500).send("Internal server error");
    }
});

// Forgot Password Flow
app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { error: null });
});

app.post('/forgot-password', (req, res) => {
    const { username } = req.body;
    if (username === 'admin') {
        return res.redirect('/recover-password');
    }
    db.query("SELECT * FROM users WHERE username = ?", [username], (err, results) => {
        if (err || results.length === 0) {
            return res.render('forgot-password', { error: 'User not found.' });
        }
        res.render('forgot-password-verify', { user: results[0], error: null });
    });
});

app.post('/forgot-password/verify', async (req, res) => {
    const { username, securityAnswer } = req.body;
    db.query("SELECT * FROM users WHERE username = ?", [username], async (err, results) => {
        if (err || results.length === 0) return res.render('forgot-password-verify', { user: { username }, error: 'User not found.' });

        const user = results[0];

        // Prevent standard reset for admin, route to master recovery
        if (user.username === 'admin') {
            return res.redirect('/recover-password');
        }

        try {
            const match = await bcrypt.compare(securityAnswer, user.security_answer_hash || '');
            if (match) {
                req.session.resetAuthorized = true;
                req.session.resetUserId = user.id;
                req.session.username = user.username;
                req.session.role = user.role;
                res.redirect('/setup-password');
            } else {
                res.render('forgot-password-verify', { user, error: 'Incorrect security answer.' });
            }
        } catch (error) {
            console.error("Error verifying answer:", error);
            res.render('forgot-password-verify', { user, error: 'An error occurred. Please try again.' });
        }
    });
});

app.post('/forgot-password/request-admin-reset', (req, res) => {
    const { username } = req.body;
    db.query("UPDATE users SET password_reset_requested = true WHERE username = ?", [username], (err) => {
        if (err) {
            console.error("Error requesting admin reset:", err);
            return res.render('forgot-password-verify', { user: { username }, error: 'An error occurred. Please try again.' });
        }
        res.render('login', { error: null, successMessage: "Your reset request has been sent to the clinic staff." });
    });
});

// Admin-Assisted Reset Flow
app.post('/staff/reset-user/:id', async (req, res) => {
    if (req.session.role !== 'staff' && req.session.role !== 'admin') {
        return res.status(403).send("Forbidden");
    }
    const targetUserId = req.params.id;

    db.query("SELECT * FROM users WHERE id = ?", [targetUserId], async (err, results) => {
        if (err || results.length === 0) return res.status(404).send("User not found");

        const targetUser = results[0];
        if (targetUser.username === 'admin') {
            return res.status(403).send("Cannot reset the system admin account");
        }

        if (req.session.role === 'staff' && targetUser.role === 'staff') {
            return res.status(403).send("Unauthorized: Staff cannot reset other staff codes.");
        }

        const accessCode = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 char hex
        try {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(accessCode, salt);

            db.query("UPDATE users SET password_hash = ?, temp_access_code = ?, requires_password_reset = true WHERE id = ?", [hashedPassword, accessCode, targetUserId], (err) => {
                if (err) return res.status(500).send("Database error");

                // Audit log: record the password reset action
                db.query(
                    "INSERT INTO admin_audit_log (actor, action_type, target_user, details) VALUES (?, 'PASSWORD_RESET', ?, ?)",
                    [req.session.username, targetUser.username, `Temp code issued (first 4: ${accessCode.slice(0, 4)}…)`],
                    (auditErr) => { if (auditErr) console.error('Audit log error:', auditErr); }
                );

                db.query("SELECT * FROM users", (err, users) => {
                    if (err) return res.status(500).send("Database error");
                    const activeTab = targetUser.role === 'customer' ? 'customers' : 'staff';
                    res.render('user-directory', { users, resetAccessCode: accessCode, resetUsername: targetUser.username, activeTab });
                });
            });
        } catch (error) {
            console.error("Error hashing access code:", error);
            res.status(500).send("Internal server error");
        }
    });
});



// ==========================================
// SOFT DELETE WORKFLOW
// ==========================================

// TODO(security): Implement CSRF protection for state-changing routes
app.post('/customer/request-deletion', requireRole('customer'), (req, res) => {
    db.query("UPDATE users SET status = 'deletion_requested' WHERE username = ?", [req.session.username], (err) => {
        if (err) {
            console.error("Error requesting deletion:", err);
            return res.status(500).send("Database error");
        }
        // Do not destroy the session; they are allowed to use the app until a staff approves deletion
        res.redirect('/customer-dashboard');
    });
});

app.post('/cancel-deletion-request/:id', (req, res) => {
    const targetId = req.params.id;
    db.query("SELECT username FROM users WHERE id = ?", [targetId], (lookupErr, lookupRows) => {
        const targetUsername = (!lookupErr && lookupRows.length > 0) ? lookupRows[0].username : `id:${targetId}`;
        db.query("UPDATE users SET status = 'active' WHERE id = ?", [targetId], (err) => {
            if (err) {
                console.error("Error canceling deletion:", err);
                return res.status(500).send("Database error");
            }
            // Audit log
            db.query(
                "INSERT INTO admin_audit_log (actor, action_type, target_user, details) VALUES (?, 'DELETION_CANCELLED', ?, 'Deletion request reversed')",
                [req.session.username || 'system', targetUsername],
                (auditErr) => { if (auditErr) console.error('Audit log error:', auditErr); }
            );
            res.redirect('/user-directory?tab=customers');
        });
    });
});

// TODO(security): Implement CSRF protection for state-changing routes
app.post('/staff/approve-deletion/:id', requireRole('staff'), (req, res) => {
    const targetId = req.params.id;
    // Look up the target username first so we can rename it on delete
    db.query("SELECT username FROM users WHERE id = ?", [targetId], (lookupErr, lookupRows) => {
        if (lookupErr || lookupRows.length === 0) return res.status(500).send("User not found.");
        const originalUsername = lookupRows[0].username;
        // Truncate to 50 chars before appending suffix to respect VARCHAR limits
        const deletedUsername = originalUsername.slice(0, 50) + '_deleted_' + Date.now();
        db.query(
            "UPDATE users SET status = 'deleted', username = ? WHERE id = ? AND role = 'customer'",
            [deletedUsername, targetId],
            (err) => {
                if (err) {
                    console.error("Error approving deletion:", err);
                    return res.status(500).send("Database error");
                }
                // Audit log — record ORIGINAL username for traceability
                db.query(
                    "INSERT INTO admin_audit_log (actor, action_type, target_user, details) VALUES (?, 'DELETION_APPROVED', ?, 'Customer account soft-deleted; username freed for re-use')",
                    [req.session.username, originalUsername],
                    (auditErr) => { if (auditErr) console.error('Audit log error:', auditErr); }
                );
                res.redirect('/user-directory?tab=customers');
            }
        );
    });
});

// TODO(security): Implement CSRF protection for state-changing routes
app.post('/admin/delete-staff/:id', requireRole('staff'), (req, res) => {
    if (req.session.username !== 'admin') {
        return res.status(403).send("Forbidden: Only the system admin can delete staff accounts.");
    }

    const targetId = req.params.id;

    db.query("SELECT username FROM users WHERE id = ?", [targetId], (err, results) => {
        if (err || results.length === 0) return res.status(500).send("User not found.");

        if (results[0].username === 'admin') {
            return res.status(403).send("Forbidden: Cannot delete the primary admin account.");
        }

        const originalUsername = results[0].username;
        const deletedUsername = originalUsername.slice(0, 50) + '_deleted_' + Date.now();

        db.query(
            "UPDATE users SET status = 'deleted', username = ? WHERE id = ? AND role = 'staff'",
            [deletedUsername, targetId],
            (err2) => {
                if (err2) {
                    console.error("Error deleting staff:", err2);
                    return res.status(500).send("Database error");
                }
                // Audit log — record ORIGINAL username for traceability
                db.query(
                    "INSERT INTO admin_audit_log (actor, action_type, target_user, details) VALUES (?, 'STAFF_ACCOUNT_DELETED', ?, 'Staff account deleted by admin; username freed for re-use')",
                    [req.session.username, originalUsername],
                    (auditErr) => { if (auditErr) console.error('Audit log error:', auditErr); }
                );
                res.redirect('/user-directory');
            }
        );
    });
});

app.post('/admin/delete-customer/:id', requireRole('staff'), (req, res) => {
    if (req.session.username !== 'admin') {
        return res.status(403).send("Forbidden: Only the system admin can delete customer accounts.");
    }

    const targetId = req.params.id;

    db.query("SELECT username, role FROM users WHERE id = ?", [targetId], (err, results) => {
        if (err || results.length === 0) return res.status(500).send("User not found.");

        if (results[0].username === 'admin') {
            return res.status(403).send("Forbidden: Cannot delete the primary admin account.");
        }

        if (results[0].role !== 'customer') {
            return res.status(400).send("Bad Request: User is not a customer.");
        }

        const originalUsername = results[0].username;
        const deletedUsername = originalUsername.slice(0, 50) + '_deleted_' + Date.now();

        db.query(
            "UPDATE users SET status = 'deleted', username = ? WHERE id = ? AND role = 'customer'",
            [deletedUsername, targetId],
            (err2) => {
                if (err2) {
                    console.error("Error deleting customer:", err2);
                    return res.status(500).send("Database error");
                }
                // Audit log
                db.query(
                    "INSERT INTO admin_audit_log (actor, action_type, target_user, details) VALUES (?, 'CUSTOMER_ACCOUNT_DELETED', ?, 'Customer account hard-deleted by admin')",
                    [req.session.username, results[0].username],
                    (auditErr) => { if (auditErr) console.error('Audit log error:', auditErr); }
                );
                res.redirect('/user-directory');
            });
    });
});



// ==========================================
// PET CRUD ROUTES
// ==========================================

app.get('/addpet', requireRole('customer'), (req, res) => {
    res.render('addpet', { error: null, form: {} });
});

app.post('/addpet', requireRole('customer'), upload.single('photo'), (req, res) => {
    const petName = req.body.name;
    const petSpecies = req.body.species;
    let petBreed = req.body.breed;
    if (petBreed === 'other') {
        petBreed = req.body.customBreed;
    }

    const petGender = req.body.gender;
    const petAge = parseFloat(req.body.age);
    const ownerId = req.session.userId;
    // `pets.photo` is NOT NULL in the database, so a pet without a photo stores an
    // empty string rather than NULL. photoPath() treats '' as "no photo" and the
    // views fall back to the paw placeholder.
    const petPhoto = req.file ? `/uploads/pets/${req.file.filename}` : '';

    // Re-render the form with a message and whatever the customer already typed,
    // instead of dumping them on a blank error page they have to navigate back from.
    const showError = (message) =>
        res.status(400).render('addpet', {
            error: message,
            form: {
                name: petName,
                species: petSpecies,
                breed: req.body.breed,
                customBreed: req.body.customBreed,
                gender: petGender,
                age: req.body.age
            }
        });

    if (!petName || !petSpecies || !petBreed || !petGender || !req.body.age) {
        return showError("Please fill in every field: name, species, breed, gender and age are all required.");
    }
    if (isNaN(petAge) || petAge < 0 || petAge > 50) {
        return showError("Please enter a valid age between 0 and 50 years.");
    }

    const sql = "INSERT INTO pets (owner_id, name, species, breed, gender, age, photo) VALUES (?, ?, ?, ?, ?, ?, ?)";
    db.query(sql, [ownerId, petName, petSpecies, petBreed, petGender, petAge, petPhoto], (err) => {
        if (err) {
            console.error("Error adding pet:", err);
            return showError("Sorry, we couldn't save this pet. Please check the details and try again.");
        }
        res.redirect('/customer-dashboard');
    });
});

// View a pet + its care records
app.get('/pets/view/:id', requireRole('customer'), (req, res) => {
    const petId = req.params.id;
    const CARE_RECORD_TYPES = ['Feeding', 'Vaccination', 'Medication'];
    const typeFilter = CARE_RECORD_TYPES.includes(req.query.type) ? req.query.type : null;

    db.query("SELECT * FROM pets WHERE id = ? AND owner_id = ?", [petId, req.session.userId], (err, pets) => {
        if (err) {
            console.error("Error fetching pet:", err);
            return res.status(500).send("Database error");
        }
        if (pets.length === 0) {
            return res.status(404).send("Pet not found. <a href='/customer-dashboard'>Go back</a>");
        }

        const recordsSql = typeFilter
            ? "SELECT * FROM care_records WHERE pet_id = ? AND record_type = ? ORDER BY record_date DESC"
            : "SELECT * FROM care_records WHERE pet_id = ? ORDER BY record_date DESC";
        const params = typeFilter ? [petId, typeFilter] : [petId];

        db.query(recordsSql, params, (err, records) => {
            if (err) {
                console.error("Error fetching care records:", err);
                return res.status(500).send("Database error");
            }
            if (pets[0].photo && (pets[0].photo.includes('\\') || /^[A-Za-z]:/.test(pets[0].photo))) {
                pets[0].photo = `/uploads/pets/${path.basename(pets[0].photo)}`;
            }
            res.render('viewpet', { pet: pets[0], records, typeFilter });
        });
    });
});

// Add a care record
app.post('/pets/:id/care-records', requireRole('customer'), (req, res) => {
    const petId = req.params.id;
    const recordType = req.body.record_type;
    const description = req.body.description;
    const recordDate = req.body.record_date;

    if (!recordType || !recordDate) {
        return res.status(400).send("Record type and date are required! <a href='/pets/view/" + petId + "'>Go back</a>");
    }

    // Only insert if this pet belongs to the logged-in customer
    const sql = `
        INSERT INTO care_records (pet_id, record_type, description, record_date)
        SELECT ?, ?, ?, ?
        FROM pets WHERE id = ? AND owner_id = ?
    `;
    db.query(sql, [petId, recordType, description, recordDate, petId, req.session.userId], (err, result) => {
        if (err) {
            console.error("Error adding care record:", err);
            return res.status(500).send("Database error");
        }
        if (result.affectedRows === 0) {
            return res.status(404).send("Pet not found. <a href='/customer-dashboard'>Go back</a>");
        }
        res.redirect(`/pets/view/${petId}`);
    });
});

// Edit pet GET
app.get('/pets/edit/:id', requireRole('customer'), (req, res) => {
    const petId = req.params.id;
    db.query("SELECT * FROM pets WHERE id = ? AND owner_id = ?", [petId, req.session.userId], (err, pets) => {
        if (err) {
            console.error("Error fetching pet:", err);
            return res.status(500).send("Database error");
        }
        if (pets.length === 0) {
            return res.status(404).send("Pet not found. <a href='/customer-dashboard'>Go back</a>");
        }
        if (pets[0].photo && (pets[0].photo.includes('\\') || /^[A-Za-z]:/.test(pets[0].photo))) {
            pets[0].photo = `/uploads/pets/${path.basename(pets[0].photo)}`;
        }
        res.render('editpet', { pet: pets[0], error: null });
    });
});

// Edit pet POST
app.post('/pets/edit/:id', requireRole('customer'), upload.single('photo'), (req, res) => {
    const petId = req.params.id;
    const petName = req.body.name;
    const petSpecies = req.body.species;
    let petBreed = req.body.breed;
    if (petBreed === 'other') {
        petBreed = req.body.customBreed;
    }

    const petGender = req.body.gender;
    const petAge = parseFloat(req.body.age);

    // Show the problem on the form itself, keeping what the customer typed.
    const showError = (message) =>
        db.query("SELECT * FROM pets WHERE id = ? AND owner_id = ?", [petId, req.session.userId], (e, rows) => {
            if (e || rows.length === 0) {
                return res.status(400).send("Could not save this pet. <a href='/customer-dashboard'>Go back</a>");
            }
            const pet = rows[0];
            // Keep the submitted values on screen so nothing has to be retyped
            pet.name = petName || pet.name;
            pet.species = petSpecies || pet.species;
            pet.breed = petBreed || pet.breed;
            pet.gender = petGender || pet.gender;
            pet.age = req.body.age || pet.age;
            res.status(400).render('editpet', { pet, error: message });
        });

    if (!petName || !petSpecies || !petBreed || !petGender || !req.body.age) {
        return showError("Please fill in every field: name, species, breed, gender and age are all required.");
    }
    if (isNaN(petAge) || petAge < 0 || petAge > 50) {
        return showError("Please enter a valid age between 0 and 50 years.");
    }

    db.query("SELECT photo FROM pets WHERE id = ? AND owner_id = ?", [petId, req.session.userId], (err, pets) => {
        if (err) {
            console.error("Error fetching pet:", err);
            return res.status(500).send("Database error");
        }
        if (pets.length === 0) {
            return res.status(404).send("Pet not found. <a href='/customer-dashboard'>Go back</a>");
        }

        // photo is NOT NULL in the database — keep the existing value (or '') when
        // no new file was uploaded.
        const photoPath = req.file ? `/uploads/pets/${req.file.filename}` : (pets[0].photo || '');
        const sql = "UPDATE pets SET name = ?, species = ?, breed = ?, gender = ?, age = ?, photo = ? WHERE id = ? AND owner_id = ?";

        db.query(sql, [petName, petSpecies, petBreed, petGender, petAge, photoPath, petId, req.session.userId], (err2) => {
            if (err2) {
                console.error("Error updating pet:", err2);
                return showError("Sorry, we couldn't save your changes. Please try again.");
            }
            res.redirect('/customer-dashboard');
        });
    });
});

// Delete pet POST
app.post('/pets/delete/:id', requireRole('customer'), (req, res) => {
    const petId = req.params.id;

    // Confirm the pet belongs to this customer before touching anything.
    db.query("SELECT id FROM pets WHERE id = ? AND owner_id = ?", [petId, req.session.userId], (err, rows) => {
        if (err) {
            console.error("Error deleting pet:", err);
            return res.status(500).send("Database error");
        }
        if (rows.length === 0) {
            return res.status(404).send("Pet not found. <a href='/customer-dashboard'>Go back</a>");
        }

        // Remove the pet's dependent rows first. Without this the appointment and
        // reminder rows survive with a pet_id that no longer resolves, which is why
        // staff lists ended up showing a raw pet ID instead of a name.
        db.query("DELETE FROM care_records WHERE pet_id = ?", [petId], (err1) => {
            if (err1) console.error("Error deleting pet care records:", err1);

            db.query("DELETE FROM reminders WHERE pet_id = ?", [petId], (err2) => {
                if (err2) console.error("Error deleting pet reminders:", err2);

                db.query("DELETE FROM appointments WHERE pet_id = ?", [petId], (err3) => {
                    if (err3) console.error("Error deleting pet appointments:", err3);

                    // Expenses are logged per pet as well; clear the link so the
                    // owner's expense list doesn't point at a pet that is gone.
                    db.query("UPDATE expenses SET pet_id = NULL WHERE pet_id = ?", [petId], (err4) => {
                        if (err4) console.error("Error clearing pet expenses:", err4);

                        db.query("DELETE FROM pets WHERE id = ? AND owner_id = ?", [petId, req.session.userId], (err5) => {
                            if (err5) {
                                console.error("Error deleting pet:", err5);
                                return res.status(500).send("Database error");
                            }
                            res.redirect('/customer-dashboard');
                        });
                    });
                });
            });
        });
    });
});
// ==========================================
// CARE REMINDERS ROUTES
// ==========================================

// Customer - View all reminders
app.get('/reminders', requireRole('customer'), (req, res) => {

    const sql = `
        SELECT reminders.*, pets.name AS pet_name
        FROM reminders
        INNER JOIN pets
        ON reminders.pet_id = pets.id
        WHERE pets.owner_id = ?
        ORDER BY due_date ASC
    `;

    db.query(sql, [req.session.userId], (err, reminders) => {

        if (err) {
            console.error("Error fetching reminders:", err);
            return res.status(500).send("Database error");
        }

        const today = new Date();

        reminders.forEach(reminder => {

            const dueDate = new Date(reminder.due_date);

            today.setHours(0, 0, 0, 0);
            dueDate.setHours(0, 0, 0, 0);

            const diffDays = Math.ceil(
                (dueDate - today) / (1000 * 60 * 60 * 24)
            );

            if (reminder.status === "Completed") {
                reminder.displayStatus = "Completed";
            }
            else if (diffDays < 0) {
                reminder.displayStatus = "Overdue";
            }
            else if (diffDays === 0) {
                reminder.displayStatus = "Due Today";
            }
            else {
                reminder.displayStatus = "Upcoming";
            }

        });

        res.render("reminders", {
            reminders
        });

    });

});


// Display Add Reminder Page
app.get('/reminders/add', requireRole('customer'), (req, res) => {

    db.query("SELECT id, name FROM pets WHERE owner_id = ?", [req.session.userId], (err, pets) => {

        if (err) {
            console.error(err);
            return res.status(500).send("Database error");
        }

        res.render("addReminder", {
            pets
        });

    });

});


// Add Reminder
app.post('/reminders/add', requireRole('customer'), (req, res) => {

    const {
        pet_id,
        reminder_title,
        due_date,
        status
    } = req.body;

    // Only insert if the chosen pet belongs to the logged-in customer
    const sql = `
        INSERT INTO reminders
        (pet_id, reminder_title, due_date, status)
        SELECT ?, ?, ?, ?
        FROM pets WHERE id = ? AND owner_id = ?
    `;

    db.query(
        sql,
        [
            pet_id,
            reminder_title,
            due_date,
            status,
            pet_id,
            req.session.userId
        ],
        (err, result) => {

            if (err) {
                console.error(err);
                return res.status(500).send("Database error");
            }

            if (result.affectedRows === 0) {
                return res.status(400).send("Invalid pet selected. <a href='/reminders/add'>Go back</a>");
            }

            res.redirect("/reminders");

        }
    );

});


// Edit Reminder Page
app.get('/reminders/edit/:id', requireRole('customer'), (req, res) => {

    const reminderId = req.params.id;

    db.query(
        `SELECT reminders.*
         FROM reminders
         INNER JOIN pets ON reminders.pet_id = pets.id
         WHERE reminders.id = ? AND pets.owner_id = ?`,
        [reminderId, req.session.userId],
        (err, reminder) => {

            if (err) {
                console.error(err);
                return res.status(500).send("Database error");
            }

            if (reminder.length === 0) {
                return res.status(404).send("Reminder not found. <a href='/reminders'>Go back</a>");
            }

            db.query(
                "SELECT id,name FROM pets WHERE owner_id = ?",
                [req.session.userId],
                (err, pets) => {

                    if (err) {
                        console.error(err);
                        return res.status(500).send("Database error");
                    }

                    res.render("editReminder", {
                        reminder: reminder[0],
                        pets
                    });

                }
            );

        }
    );

});


// Update Reminder
app.post('/reminders/edit/:id', requireRole('customer'), (req, res) => {

    const reminderId = req.params.id;

    const {
        pet_id,
        reminder_title,
        due_date,
        status
    } = req.body;

    // Guard: reminder must currently belong to one of this customer's pets,
    // and the new pet_id must also belong to this customer.
    const sql = `
        UPDATE reminders
        SET
            pet_id=?,
            reminder_title=?,
            due_date=?,
            status=?
        WHERE id=?
          AND pet_id IN (SELECT id FROM pets WHERE owner_id = ?)
          AND ? IN (SELECT id FROM pets WHERE owner_id = ?)
    `;

    db.query(
        sql,
        [
            pet_id,
            reminder_title,
            due_date,
            status,
            reminderId,
            req.session.userId,
            pet_id,
            req.session.userId
        ],
        (err, result) => {

            if (err) {
                console.error(err);
                return res.status(500).send("Database error");
            }

            if (result.affectedRows === 0) {
                return res.status(404).send("Reminder not found. <a href='/reminders'>Go back</a>");
            }

            res.redirect("/reminders");

        }
    );

});


// Delete Reminder
app.post('/reminders/delete/:id', requireRole('customer'), (req, res) => {

    const reminderId = req.params.id;

    db.query(
        `DELETE FROM reminders
         WHERE id=?
           AND pet_id IN (SELECT id FROM pets WHERE owner_id = ?)`,
        [reminderId, req.session.userId],
        (err) => {

            if (err) {
                console.error(err);
                return res.status(500).send("Database error");
            }

            res.redirect("/reminders");

        }
    );

});


// Staff - View All Reminders
app.get('/staff/reminders', requireRole('staff'), (req, res) => {

    const sql = `
        SELECT reminders.*,
               pets.name AS pet_name
        FROM reminders
        INNER JOIN pets
        ON reminders.pet_id = pets.id
        ORDER BY due_date ASC
    `;

    db.query(sql, (err, reminders) => {

        if (err) {
            console.error(err);
            return res.status(500).send("Database error");
        }

        res.render("reminders", {
            reminders
        });

    });

});
// ==========================================
// APPOINTMENTS ROUTES
// ==========================================

// New appointment form – fetch pets for dropdown
app.get('/appointments/new', requireRole('customer'), (req, res) => {
    const petsSql = "SELECT id, name, species, breed FROM pets WHERE owner_id = ?";

    db.query(petsSql, [req.session.userId], (err, pets) => {
        if (err) {
            console.error("Error fetching pets for appointments:", err);
            return res.status(500).send("Database error");
        }

        // Available vets = active staff users the customer can book with.
        // The system 'admin' account has role 'staff' too, so exclude it by username.
        const vetsSql = `
            SELECT id, name
            FROM users
            WHERE role = 'staff' AND status = 'active' AND username <> 'admin'
            ORDER BY name
        `;
        db.query(vetsSql, (err2, vets) => {
            if (err2) {
                console.error("Error fetching vets for appointments:", err2);
                return res.status(500).send("Database error");
            }
            // No bookedTimes here; front-end JS will fetch them
            res.render('appointments_new', { pets, vets });
        });
    });
});

// API: return booked times for a vet + date as JSON (used by JS on /appointments/new)
app.get('/api/appointments/slots', requireRole('customer'), (req, res) => {
    const { vet_id, date } = req.query;

    if (!vet_id || !date) {
        return res.json({ bookedTimes: [] });
    }

    const sql = `
        SELECT start_time
        FROM appointments
        WHERE vet_id = ?
          AND date = ?
          AND status <> 'cancelled'
    `;

    db.query(sql, [vet_id, date], (err, rows) => {
        if (err) {
            console.error('Error fetching booked slots:', err);
            return res.status(500).json({ bookedTimes: [] });
        }

        const bookedTimes = rows.map(r => String(r.start_time)); // e.g. ['11:00:00']
        res.json({ bookedTimes });
    });
});

// Create appointment with conflict checking (single time slot)
app.post('/appointments', requireRole('customer'), (req, res) => {
    const { pet_id, vet_id, date, slot_time, reason } = req.body;

    const owner_id = req.session.userId; // logged-in customer

    if (!pet_id || !vet_id || !date || !slot_time) {
        return res.status(400).send("Pet, vet, date, and time slot are required. <a href='/appointments/new'>Go back</a>");
    }

    // Reject bookings in the past. The browser sets a min date, but never trust it —
    // a past date, or a time that already passed today, must be blocked here too.
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).send("Please choose a valid date. <a href='/appointments/new'>Go back</a>");
    }
    if (date < todayStr) {
        return res.status(400).send("You can't book an appointment in the past. <a href='/appointments/new'>Pick a future date</a>");
    }
    if (date === todayStr) {
        const nowTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        // slot_time is "HH:00:00"; a same-format string compare is safe here.
        if (String(slot_time) <= nowTime) {
            return res.status(400).send("That time slot has already passed today. <a href='/appointments/new'>Pick a later slot</a>");
        }
    }

    const start_time = slot_time;
    const end_time = slot_time;

    // Validate the selected vet is a real active staff user (not the system admin)
    db.query(
        "SELECT id FROM users WHERE id = ? AND role = 'staff' AND status = 'active' AND username <> 'admin'",
        [vet_id],
        (errVet, vets) => {
            if (errVet) {
                console.error('Vet validation error:', errVet);
                return res.status(500).send("Unexpected error. <a href='/appointments/new'>Go back</a>");
            }
            if (vets.length === 0) {
                return res.status(400).send("Invalid vet selected. <a href='/appointments/new'>Go back</a>");
            }

            // Slots are discrete one-hour times: a slot clashes only with a
            // non-cancelled booking for the SAME vet, date and start time.
            const conflictSql = `
                SELECT id
                FROM appointments
                WHERE vet_id = ?
                  AND date = ?
                  AND start_time = ?
                  AND status <> 'cancelled'
            `;

            db.query(conflictSql, [vet_id, date, start_time], (err, rows) => {
                if (err) {
                    console.error('Conflict check error:', err);
                    return res.status(500).send("Unexpected error while checking availability. <a href='/appointments/new'>Go back</a>");
                }

                if (rows.length > 0) {
                    return res.status(400).send("This time slot is already booked for this vet. <a href='/appointments/new'>Choose another slot</a>");
                }

                // Only book if the chosen pet belongs to the logged-in customer
                const insertSql = `
                    INSERT INTO appointments (pet_id, owner_id, vet_id, date, start_time, end_time, reason, status)
                    SELECT ?, ?, ?, ?, ?, ?, ?, 'booked'
                    FROM pets WHERE id = ? AND owner_id = ?
                `;
                db.query(
                    insertSql,
                    [pet_id, owner_id, vet_id, date, start_time, end_time, reason, pet_id, owner_id],
                    (err2, result) => {
                        if (err2) {
                            console.error('Insert appointment error:', err2);
                            return res.status(500).send("Could not book appointment. <a href='/appointments/new'>Try again</a>");
                        }

                        if (result.affectedRows === 0) {
                            return res.status(400).send("Invalid pet selected. <a href='/appointments/new'>Go back</a>");
                        }

                        res.redirect('/appointments/my');
                    }
                );
            });
        }
    );
});

// Customer-specific list: appointments I've booked
app.get('/appointments/my', requireRole('customer'), (req, res) => {
    const owner_id = req.session.userId;

    const sql = `
        SELECT a.id, a.date, a.start_time, a.end_time, a.status, a.reason,
               p.name AS pet_name, p.species AS pet_species,
               v.name AS vet_name
        FROM appointments a
        JOIN pets p ON a.pet_id = p.id
        LEFT JOIN users v ON a.vet_id = v.id
        WHERE a.owner_id = ?
        ORDER BY a.date, a.start_time
    `;

    db.query(sql, [owner_id], (err, rows) => {
        if (err) {
            console.error('Fetch my appointments error:', err);
            return res.status(500).send("Could not load your appointments.");
        }

        res.render('appointments_my', { appointments: rows });
    });
});

// List appointments – simple views for customer/staff (overview)
app.get('/appointments', (req, res) => {
    if (!req.session.role) {
        return res.redirect('/login');
    }

    // Optional status filter (used by the staff view: Booked / Completed / Cancelled)
    const STATUSES = ['booked', 'completed', 'cancelled'];
    const statusFilter = STATUSES.includes(req.query.status) ? req.query.status : '';

    // Optional date filters for the staff/admin view. `range` is a quick preset;
    // `from`/`to` are explicit yyyy-mm-dd bounds and win over the preset.
    const RANGES = ['today', 'week', 'upcoming', 'past'];
    const rangeFilter = RANGES.includes(req.query.range) ? req.query.range : '';
    const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const fromDate = isDate(req.query.from) ? req.query.from : '';
    const toDate = isDate(req.query.to) ? req.query.to : '';

    // Build the date portion of the WHERE clause plus its bound parameters.
    const dateClauses = [];
    const dateParams = [];
    if (fromDate || toDate) {
        if (fromDate) { dateClauses.push('a.date >= ?'); dateParams.push(fromDate); }
        if (toDate) { dateClauses.push('a.date <= ?'); dateParams.push(toDate); }
    } else if (rangeFilter === 'today') {
        dateClauses.push('a.date = CURDATE()');
    } else if (rangeFilter === 'week') {
        dateClauses.push('a.date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)');
    } else if (rangeFilter === 'upcoming') {
        dateClauses.push('a.date >= CURDATE()');
    } else if (rangeFilter === 'past') {
        dateClauses.push('a.date < CURDATE()');
    }
    const dateSql = dateClauses.length ? ' AND ' + dateClauses.join(' AND ') : '';

    // The system admin oversees every appointment across all vets;
    // a regular staff member (vet) only sees the ones assigned to them.
    const isAdmin = req.session.username === 'admin';

    let sql;
    let params;

    if (req.session.role === 'customer') {
        sql = `
            SELECT a.*, p.name AS pet_name, v.name AS vet_name
            FROM appointments a
            LEFT JOIN pets p ON a.pet_id = p.id
            LEFT JOIN users v ON a.vet_id = v.id
            WHERE a.owner_id = ?
              ${statusFilter ? 'AND a.status = ?' : ''}
            ORDER BY a.date, a.start_time
        `;
        params = statusFilter ? [req.session.userId, statusFilter] : [req.session.userId];
    } else if (isAdmin) {
        // All appointments, with both the owner and the assigned vet.
        sql = `
            SELECT a.*, p.name AS pet_name, o.name AS owner_name, v.name AS vet_name
            FROM appointments a
            LEFT JOIN pets p ON a.pet_id = p.id
            LEFT JOIN users o ON a.owner_id = o.id
            LEFT JOIN users v ON a.vet_id = v.id
            WHERE 1 = 1
              ${statusFilter ? 'AND a.status = ?' : ''}
              ${dateSql}
            ORDER BY a.date, a.start_time
        `;
        params = statusFilter ? [statusFilter, ...dateParams] : [...dateParams];
    } else if (req.session.role === 'staff') {
        sql = `
            SELECT a.*, p.name AS pet_name, o.name AS owner_name
            FROM appointments a
            LEFT JOIN pets p ON a.pet_id = p.id
            LEFT JOIN users o ON a.owner_id = o.id
            WHERE a.vet_id = ?
              ${statusFilter ? 'AND a.status = ?' : ''}
              ${dateSql}
            ORDER BY a.date, a.start_time
        `;
        params = statusFilter
            ? [req.session.userId, statusFilter, ...dateParams]
            : [req.session.userId, ...dateParams];
    } else {
        return res.status(403).send("Forbidden.");
    }

    db.query(sql, params, (err, rows) => {
        if (err) {
            console.error('Fetch appointments error:', err);
            return res.status(500).send("Could not load appointments.");
        }

        res.render('appointments_index', {
            appointments: rows,
            statusFilter,
            isAdmin,
            rangeFilter,
            fromDate,
            toDate
        });
    });
});

// Customer cancels one of their own appointments
app.post('/appointments/:id/cancel', (req, res) => {
    const appointmentId = req.params.id;
    const role = req.session.role;

    // A customer may cancel their own booking; a vet may cancel one assigned to them.
    let sql, params, redirectTo;
    if (role === 'customer') {
        sql = "UPDATE appointments SET status = 'cancelled' WHERE id = ? AND owner_id = ?";
        params = [appointmentId, req.session.userId];
        redirectTo = '/appointments/my';
    } else if (role === 'staff' || role === 'admin') {
        sql = "UPDATE appointments SET status = 'cancelled' WHERE id = ? AND vet_id = ?";
        params = [appointmentId, req.session.userId];
        redirectTo = '/appointments';
    } else {
        return res.redirect('/login');
    }

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error('Cancel appointment error:', err);
            return res.status(500).send("Could not cancel appointment.");
        }

        if (result.affectedRows === 0) {
            return res.status(404).send("Appointment not found or not yours to cancel.");
        }

        res.redirect(redirectTo);
    });
});

// Staff marks appointment as completed
app.post('/appointments/:id/complete', requireRole('staff'), (req, res) => {
    const appointmentId = req.params.id;
    const vet_id = req.session.userId;

    db.query("SELECT * FROM appointments WHERE id = ? AND vet_id = ?", [appointmentId, vet_id], (err, rows) => {
        if (err || rows.length === 0) return res.status(500).send("Error fetching appointment.");

        const appt = rows[0];

        db.query("UPDATE appointments SET status = 'completed' WHERE id = ?", [appointmentId], (err2) => {
            if (err2) return res.status(500).send("Error updating appointment.");

            const title = encodeURIComponent(`Vet Consultation - ${appt.reason || 'General Checkup'}`);
            const category = encodeURIComponent('Vet Visit');
            const amount = "50.00";

            // Redirect to the invoice form, fully pre-filled
            res.redirect(`/staff/invoices/new?owner_id=${appt.owner_id}&pet_id=${appt.pet_id}&title=${title}&category=${category}&amount=${amount}`);
        });
    });
});

// ==========================================
// NOTIFICATIONS ROUTES
// ==========================================

app.get('/notifications', requireRole('customer'), (req, res) => {
    db.query("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC", [req.session.userId], (err, notifications) => {
        if (err) return res.status(500).send("Database error");
        res.render('notifications', { notifications });
    });
});

app.post('/notifications/:id/read', requireRole('customer'), (req, res) => {
    db.query("UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?", [req.params.id, req.session.userId], (err) => {
        res.redirect('/notifications');
    });
});

app.post('/notifications/:id/delete', requireRole('customer'), (req, res) => {
    db.query("DELETE FROM notifications WHERE id = ? AND user_id = ?", [req.params.id, req.session.userId], (err) => {
        res.redirect('/notifications');
    });
});

// ==========================================
// INVOICING & EXPENSE TRACKING ROUTES
// ==========================================
const EXPENSE_CATEGORIES = ['Food', 'Vet Visit', 'Medication', 'Grooming', 'Boarding', 'Insurance', 'Toys & Accessories', 'Other'];

// ---------- Staff: View & Create Invoices ----------
app.get('/staff/invoices', requireRole('staff'), (req, res) => {
    const sql = `
        SELECT i.*, o.name AS owner_name, p.name AS pet_name 
        FROM invoices i
        LEFT JOIN users o ON i.owner_id = o.id
        LEFT JOIN pets p ON i.pet_id = p.id
        ORDER BY i.created_at DESC
    `;
    db.query(sql, (err, invoices) => {
        if (err) return res.status(500).send("Database error");

        const aggSql = `SELECT category, SUM(amount) as total FROM invoices WHERE status = 'paid' GROUP BY category`;
        db.query(aggSql, (err2, aggData) => {
            if (err2) return res.status(500).send("Database error");
            res.render('staff-invoices', { invoices, aggData });
        });
    });
});

app.get('/staff/invoices/new', requireRole('staff'), (req, res) => {
    const prefill = req.query || {};
    db.query("SELECT id, name FROM users WHERE role = 'customer' AND status = 'active'", (err, customers) => {
        if (err) return res.status(500).send("Database error");
        db.query("SELECT id, name, owner_id FROM pets", (err2, pets) => {
            if (err2) return res.status(500).send("Database error");
            res.render('staff-invoice-new', { customers, pets, categories: EXPENSE_CATEGORIES, prefill });
        });
    });
});

app.post('/staff/invoices/new', requireRole('staff'), (req, res) => {
    const { owner_id, pet_id, title, category, amount } = req.body;
    const staff_id = req.session.userId;
    const petIdValue = pet_id ? pet_id : null;

    db.query(
        "INSERT INTO invoices (owner_id, pet_id, staff_id, title, category, amount) VALUES (?, ?, ?, ?, ?, ?)",
        [owner_id, petIdValue, staff_id, title, category, amount],
        (err, result) => {
            if (err) return res.status(500).send("Database error");

            // Notify the customer
            const msg = `New invoice received: ${title} for $${amount}.`;
            db.query("INSERT INTO notifications (user_id, message) VALUES (?, ?)", [owner_id, msg], () => {
                res.redirect('/staff/invoices');
            });
        }
    );
});

// ---------- Customer: Expenses & Pending Invoices ----------
app.get('/expenses', requireRole('customer'), (req, res) => {
    const ownerId = req.session.userId;

    // 1. Get Pending Invoices
    db.query("SELECT i.*, p.name AS pet_name FROM invoices i LEFT JOIN pets p ON i.pet_id = p.id WHERE i.owner_id = ? AND i.status = 'pending' ORDER BY i.created_at ASC", [ownerId], (err, pendingInvoices) => {
        if (err) {
            console.error("Error fetching pending invoices:", err);
            return res.status(500).send("Database error");
        }

        // 2. Get Expense Log (Auto-generated from paid invoices)
        db.query("SELECT e.*, p.name AS pet_name FROM expenses e LEFT JOIN pets p ON e.pet_id = p.id WHERE e.owner_id = ? ORDER BY e.expense_date DESC", [ownerId], (err2, expenses) => {
            if (err2) {
                console.error("Error fetching expenses:", err2);
                return res.status(500).send("Database error");
            }

            // 3. Get Aggregated Data for the Pie Chart (Current Month Spending)
            const aggSql = `
                SELECT category, COALESCE(SUM(amount), 0) as total 
                FROM expenses 
                WHERE owner_id = ? 
                  AND MONTH(expense_date) = MONTH(CURDATE()) 
                  AND YEAR(expense_date) = YEAR(CURDATE())
                GROUP BY category
            `;

            db.query(aggSql, [ownerId], (err3, aggData) => {
                if (err3) {
                    console.error("Error fetching aggregated data:", err3);
                    return res.status(500).send("Database error");
                }

                // Render the view and pass pendingInvoices, expenses, AND aggData
                res.render('expenses', {
                    pendingInvoices,
                    expenses,
                    aggData
                });
            });
        });
    });
});

// ---------- Customer: Simulated Checkout ----------
app.get('/checkout/:id', requireRole('customer'), (req, res) => {
    const ownerId = req.session.userId;
    db.query("SELECT * FROM invoices WHERE id = ? AND owner_id = ? AND status = 'pending'", [req.params.id, ownerId], (err, invoices) => {
        if (err || invoices.length === 0) return res.redirect('/expenses');

        // Fetch saved card details
        db.query("SELECT saved_card_name, saved_card_last4, saved_card_expiry FROM users WHERE id = ?", [ownerId], (err2, users) => {
            const savedCard = (users && users.length > 0) ? users[0] : null;
            res.render('checkout', { invoice: invoices[0], savedCard });
        });
    });
});

app.post('/checkout/:id', requireRole('customer'), (req, res) => {
    const invoiceId = req.params.id;
    const ownerId = req.session.userId;
    const { cardName, cardNumber, expiryDate, saveCard } = req.body;

    // Verify invoice exists and is pending
    db.query("SELECT * FROM invoices WHERE id = ? AND owner_id = ? AND status = 'pending'", [invoiceId, ownerId], (err, rows) => {
        if (err || rows.length === 0) return res.status(404).send("Invoice not found or already paid.");

        const invoice = rows[0];

        // 1. Mark invoice as paid
        db.query("UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = ?", [invoiceId], (err2) => {
            if (err2) return res.status(500).send("Database error updating invoice");

            // 2. Auto-insert into expenses log
            const insertExpense = `INSERT INTO expenses (owner_id, pet_id, category, description, amount, expense_date) VALUES (?, ?, ?, ?, ?, CURDATE())`;
            db.query(insertExpense, [ownerId, invoice.pet_id, invoice.category, invoice.title, invoice.amount], (err3) => {
                if (err3) return res.status(500).send("Database error creating expense");

                // 3. Save the card if requested
                if (saveCard === 'on' && cardNumber) {
                    let last4 = cardNumber;
                    // Extract last 4 whether it's masked or raw
                    if (cardNumber.includes('•')) {
                        last4 = cardNumber.slice(-4);
                    } else {
                        last4 = cardNumber.replace(/\D/g, '').slice(-4);
                    }
                    db.query("UPDATE users SET saved_card_name = ?, saved_card_last4 = ?, saved_card_expiry = ? WHERE id = ?", [cardName, last4, expiryDate, ownerId]);
                }

                // 4. Redirect to Receiptify page
                res.redirect(`/receipt/${invoiceId}`);
            });
        });
    });
});

// ---------- Customer: Post-Payment Receipt & Review ----------
app.get('/receipt/:id', requireRole('customer'), (req, res) => {
    db.query("SELECT * FROM invoices WHERE id = ? AND owner_id = ? AND status = 'paid'", [req.params.id, req.session.userId], (err, rows) => {
        if (err || rows.length === 0) return res.redirect('/expenses');
        res.render('receipt', { invoice: rows[0] });
    });
});

app.post('/receipt/:id/review', requireRole('customer'), (req, res) => {
    const { rating, comment } = req.body;
    db.query("INSERT INTO reviews (invoice_id, user_id, rating, comment) VALUES (?, ?, ?, ?)", [req.params.id, req.session.userId, rating, comment], (err) => {
        res.redirect('/expenses');
    });
});

// ---------- Staff/Admin: Clinic-wide expense log + pie chart breakdown ----------
app.get('/staff/expenses', requireRole('staff'), (req, res) => {
    const isAdmin = req.session.username === 'admin';

    // Optional filters: search by owner/pet name, filter by category
    const search = (req.query.q || '').trim();
    const categoryFilter = EXPENSE_CATEGORIES.includes(req.query.category) ? req.query.category : '';

    const where = [];
    const params = [];

    if (search) {
        where.push('(o.name LIKE ? OR p.name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
    }
    if (categoryFilter) {
        where.push('e.category = ?');
        params.push(categoryFilter);
    }

    const listSql = `
        SELECT e.*, o.name AS owner_name, p.name AS pet_name
        FROM expenses e
        LEFT JOIN users o ON e.owner_id = o.id
        LEFT JOIN pets p ON e.pet_id = p.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY e.expense_date DESC, e.id DESC
    `;

    db.query(listSql, params, (err, expenses) => {
        if (err) {
            console.error("Error fetching clinic expenses:", err);
            return res.status(500).send("Database error");
        }

        const summarySql = `
            SELECT
                COALESCE(SUM(amount), 0) AS totalAll,
                COALESCE(SUM(CASE WHEN MONTH(expense_date) = MONTH(CURDATE())
                                    AND YEAR(expense_date) = YEAR(CURDATE())
                                   THEN amount ELSE 0 END), 0) AS totalThisMonth,
                COUNT(*) AS entryCount,
                COUNT(DISTINCT owner_id) AS ownerCount
            FROM expenses
        `;

        const breakdownSql = `
            SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
            FROM expenses
            GROUP BY category
            ORDER BY total DESC
        `;

        const monthlySql = `
            SELECT DATE_FORMAT(expense_date, '%Y-%m') AS ym, COALESCE(SUM(amount), 0) AS total
            FROM expenses
            WHERE expense_date >= DATE_SUB(CURDATE(), INTERVAL 5 MONTH)
            GROUP BY ym
            ORDER BY ym ASC
        `;

        db.query(summarySql, (err2, summaryRows) => {
            if (err2) {
                console.error("Error fetching clinic expense summary:", err2);
                return res.status(500).send("Database error");
            }

            db.query(breakdownSql, (err3, breakdownRows) => {
                if (err3) {
                    console.error("Error fetching clinic expense breakdown:", err3);
                    return res.status(500).send("Database error");
                }

                db.query(monthlySql, (err4, monthlyRows) => {
                    if (err4) {
                        console.error("Error fetching clinic expense monthly trend:", err4);
                        return res.status(500).send("Database error");
                    }

                    const topCategory = breakdownRows.length > 0 ? breakdownRows[0].category : null;

                    res.render('staff-expenses', {
                        expenses,
                        summary: summaryRows[0],
                        breakdown: breakdownRows,
                        monthly: monthlyRows,
                        categories: EXPENSE_CATEGORIES,
                        search,
                        categoryFilter,
                        topCategory,
                        isAdmin
                    });
                });
            });
        });
    });
});

// ---------- Staff/Admin: Remove a mis-entered expense (moderation) ----------
app.post('/staff/expenses/delete/:id', requireRole('staff'), (req, res) => {
    if (req.session.username !== 'admin') {
        return res.status(403).send("Only the system admin can remove expense entries.");
    }

    db.query("DELETE FROM expenses WHERE id = ?", [req.params.id], (err) => {
        if (err) {
            console.error("Error deleting expense (admin):", err);
            return res.status(500).send("Database error");
        }
        res.redirect('/staff/expenses');
    });
});

// ---------- Master Recovery Codes Routes ----------
app.post('/generate-recovery-codes', async (req, res) => {
    try {
        if (!req.session || req.session.role !== 'admin' || req.session.username !== 'admin') {
            return res.status(403).send('Forbidden: Admin access required.');
        }
        const users = await queryAsync('SELECT id FROM users WHERE username = ?', [req.session.username]);
        if (users.length === 0) return res.status(400).send('Admin not found');
        const adminId = users[0].id;

        const plainCodes = [];
        const saltRounds = 12;

        for (let i = 0; i < 5; i++) {
            const code = generateSecureRecoveryCode();
            plainCodes.push(code);
            const hashedCode = await bcrypt.hash(code, saltRounds);
            await queryAsync('INSERT INTO recovery_codes (user_id, code, is_used) VALUES (?, ?, 0)', [adminId, hashedCode]);
        }

        res.render('admin/recovery-codes-generated', { codes: plainCodes });
    } catch (err) {
        console.error('Error generating recovery codes:', err);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/recover-password', (req, res) => {
    res.render('recover-password');
});

app.post('/recover-password', async (req, res) => {
    try {
        let { username, recoveryCode } = req.body;
        recoveryCode = (recoveryCode || '').trim().toUpperCase();
        const users = await queryAsync('SELECT id, username, role FROM users WHERE username = ?', [username]);

        if (users.length === 0 || users[0].role !== 'admin' || users[0].username !== 'admin') {
            return res.status(401).render('recover-password', { error: 'Invalid username or recovery code.' });
        }

        const user = users[0];
        const codes = await queryAsync('SELECT id, code FROM recovery_codes WHERE user_id = ? AND is_used = 0', [user.id]);

        console.log("--- DEBUGGING RECOVERY ---");
        console.log("Code entered by user:", recoveryCode);
        console.log("Codes found in DB:", codes);
        console.log("--------------------------");

        let matchedCodeId = null;
        for (const row of codes) {
            const isMatch = await bcrypt.compare(recoveryCode, row.code);
            if (isMatch) {
                matchedCodeId = row.id;
                break;
            }
        }

        if (matchedCodeId) {
            await queryAsync('UPDATE recovery_codes SET is_used = 1 WHERE id = ?', [matchedCodeId]);
            req.session.regenerate((err) => {
                if (err) throw err;
                req.session.resetAuthorized = true;
                req.session.resetUserId = user.id;
                req.session.username = user.username;
                res.redirect('/reset-password');
            });
        } else {
            return res.status(401).render('recover-password', { error: 'Invalid username or recovery code.' });
        }
    } catch (err) {
        console.error('Error during password recovery:', err);
        return res.status(500).render('recover-password', { error: 'An internal server error occurred.' });
    }
});

app.post('/regenerate-recovery-codes', async (req, res) => {
    try {
        if (!req.session || req.session.role !== 'admin' || req.session.username !== 'admin') {
            return res.status(403).send('Forbidden: Admin access required.');
        }
        const users = await queryAsync('SELECT id, password_hash FROM users WHERE username = ?', [req.session.username]);
        if (users.length === 0) return res.status(400).send('Admin not found');
        const adminId = users[0].id;

        const { currentPassword } = req.body;
        if (!currentPassword) {
            return res.redirect('/staff/profile?error=password_required');
        }

        const isMatch = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!isMatch) {
            return res.redirect('/staff/profile?error=incorrect_password');
        }

        await beginTransactionAsync();
        try {
            await queryAsync('UPDATE recovery_codes SET is_used = 1 WHERE user_id = ?', [adminId]);
            const plainCodes = [];
            const saltRounds = 12;
            for (let i = 0; i < 5; i++) {
                const code = generateSecureRecoveryCode();
                plainCodes.push(code);
                const hashedCode = await bcrypt.hash(code, saltRounds);
                await queryAsync('INSERT INTO recovery_codes (user_id, code, is_used) VALUES (?, ?, 0)', [adminId, hashedCode]);
            }
            await commitAsync();
            res.render('admin/recovery-codes-generated', { codes: plainCodes });
        } catch (txnErr) {
            await rollbackAsync();
            throw txnErr;
        }
    } catch (err) {
        console.error('Error regenerating recovery codes:', err);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/reset-password', (req, res) => {
    if (req.session.resetAuthorized !== true) {
        return res.status(403).send('Forbidden: You must verify a recovery code first.');
    }
    res.render('reset-password', { error: null });
});

app.post('/reset-password', async (req, res) => {
    try {
        if (req.session.resetAuthorized !== true || !req.session.resetUserId) {
            return res.status(403).send("Forbidden: Unauthorized reset attempt.");
        }

        const { newPassword, confirmPassword } = req.body;

        if (newPassword !== confirmPassword) {
            return res.render('reset-password', { error: 'Passwords do not match.' });
        }

        if (newPassword.length < 8) {
            return res.render('reset-password', { error: 'Password must be at least 8 characters long.' });
        }

        const saltRounds = 12;
        const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

        // Run UPDATE query

        await queryAsync('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, req.session.resetUserId]);

        // Securely clear reset flags
        req.session.resetAuthorized = false;
        req.session.resetUserId = null;

        res.redirect('/login');
    } catch (err) {
        console.error('Error resetting password:', err);
        res.status(500).send('Internal Server Error');
    }
});



// ==========================================
// SUPER ADMIN: System Health Dashboard
// ==========================================
app.get('/admin/system-health', async (req, res) => {
    // 1. Protect the route (Super Admin Only)
    if (!req.session.username || req.session.username !== 'admin') {
        return res.redirect('/login');
    }

    // 2. Parse query parameters for search, filter, and pagination
    const LOGS_PER_PAGE = 20;
    const searchQuery = (req.query.search || '').trim();
    const selectedAction = (req.query.action || '').trim();
    const currentPage = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (currentPage - 1) * LOGS_PER_PAGE;

    // 3. Build dynamic WHERE clause for audit log queries
    const whereClauses = [];
    const whereParams = [];

    if (searchQuery) {
        whereClauses.push("(actor LIKE ? OR target_user LIKE ? OR DATE_FORMAT(created_at, '%Y-%m-%d') LIKE ?)");
        const likeVal = `%${searchQuery}%`;
        whereParams.push(likeVal, likeVal, likeVal);
    }
    if (selectedAction && selectedAction !== 'ALL') {
        whereClauses.push('action_type = ?');
        whereParams.push(selectedAction);
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    try {
        // 4. Run stat counts + audit COUNT + paginated audit rows concurrently
        const [
            customersResult,
            staffResult,
            deletionsResult,
            totalLogResult,
            auditLogs
        ] = await Promise.all([
            queryAsync("SELECT COUNT(*) AS count FROM users WHERE role = 'customer' AND status != 'deleted'"),
            queryAsync("SELECT COUNT(*) AS count FROM users WHERE role IN ('staff', 'admin') AND status != 'deleted'"),
            queryAsync("SELECT COUNT(*) AS count FROM users WHERE status = 'deletion_requested'"),
            queryAsync(`SELECT COUNT(*) AS count FROM admin_audit_log ${whereSQL}`, whereParams),
            queryAsync(
                `SELECT id, created_at, actor, action_type, target_user, details
                 FROM admin_audit_log
                 ${whereSQL}
                 ORDER BY created_at DESC
                 LIMIT ? OFFSET ?`,
                [...whereParams, LOGS_PER_PAGE, offset]
            )
        ]);

        const totalLogCount = totalLogResult[0].count;
        const totalPages = Math.max(1, Math.ceil(totalLogCount / LOGS_PER_PAGE));

        // 5. Render the view with all data
        res.render('system-health', {
            user: req.session,
            _active: 'system-health',
            totalCustomers: customersResult[0].count,
            totalStaff: staffResult[0].count,
            pendingDeletions: deletionsResult[0].count,
            auditLogs,
            totalLogCount,
            currentPage,
            totalPages,
            searchQuery,
            selectedAction
        });

    } catch (err) {
        console.error("Error loading System Health Dashboard:", err);
        res.status(500).send("Internal Server Error while loading dashboard data.");
    }
});

// ==========================================
// Start Server
// ==========================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});