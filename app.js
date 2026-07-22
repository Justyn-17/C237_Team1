const express = require('express');
const mysql = require('mysql');
const session = require('express-session');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

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
        secure: process.env.NODE_ENV === 'production',
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
    if (req.session.role !== role) {
        return res.redirect('/login');
    }
    next();
};

// DB connection (Azure MySQL)
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
            return res.render('login', { error: 'Invalid username or password.' });
        }

        const user = results[0];

        // Boundary Check: Ensure the user's role matches the portal they are trying to log in from
        if (expectedRole === 'staff' && (user.role !== 'staff' && user.role !== 'admin')) {
            return res.render('login', { error: 'Please use the correct portal for your account type.' });
        }
        if (expectedRole === 'customer' && user.role !== 'customer') {
            return res.render('login', { error: 'Please use the correct portal for your account type.' });
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
                return res.render('login', { error: 'Invalid username or password.' });
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
        const apptTodayParams = [];

        db.query(apptTodaySql, apptTodayParams, (err2, apptRows) => {
            if (err2) {
                console.error("Error fetching today's appointments:", err2);
                return res.status(500).send("Database error");
            }

            const recentSql = `SELECT a.*, p.name AS pet_name, o.name AS owner_name, v.name AS vet_name
                   FROM appointments a
                   LEFT JOIN pets p ON a.pet_id = p.id
                   LEFT JOIN users o ON a.owner_id = o.id
                   LEFT JOIN users v ON a.vet_id = v.id
                   ORDER BY a.created_at DESC
                   LIMIT 10`;
            const recentParams = [];

            db.query(recentSql, recentParams, (err3, recentRows) => {
                if (err3) {
                    console.error("Error fetching recent appointments:", err3);
                    return res.status(500).send("Database error");
                }

                const monthlySql = "SELECT MONTH(date) AS month, COUNT(*) AS count FROM appointments WHERE status <> 'cancelled' GROUP BY MONTH(date)";
                const monthlyParams = [];

                db.query(monthlySql, monthlyParams, (err4, monthlyRows) => {
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

                        res.render('staff', {
                            totalPets: petRows[0].count,
                            appointmentsToday: apptRows[0].count,
                            appointments: recentRows,
                            monthlyAppointments: monthlyAppointments,
                            speciesBreakdown: speciesBreakdown
                        });
                    });
                });
            });
        });
    });
});

// API for Recent Activity Polling
app.get('/api/recent-activity', requireRole('staff'), (req, res) => {
    const recentSql = `SELECT a.*, p.name AS pet_name, o.name AS owner_name, v.name AS vet_name
                   FROM appointments a
                   LEFT JOIN pets p ON a.pet_id = p.id
                   LEFT JOIN users o ON a.owner_id = o.id
                   LEFT JOIN users v ON a.vet_id = v.id
                   ORDER BY a.created_at DESC
                   LIMIT 10`;

    db.query(recentSql, [], (err, results) => {
        if (err) {
            console.error("Error fetching recent appointments API:", err);
            return res.status(500).json({ error: "Database error" });
        }
        res.json(results);
    });
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
                        `SELECT a.*, p.name AS pet_name, o.name AS owner_name
                         FROM appointments a
                         LEFT JOIN pets p ON a.pet_id = p.id
                         LEFT JOIN users o ON a.owner_id = o.id
                         WHERE a.vet_id = ?
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

                                    res.render('vet_dashboard', {
                                        myPatients: patientRows[0].count,
                                        myAppointmentsToday: apptRows[0].count,
                                        myAppointments: apptListRows,
                                        monthlyAppointments: monthlyAppointments,
                                        speciesBreakdown: speciesBreakdown
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
            newUsername: null
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
        return res.render('forgot-password', { error: 'Action not allowed for this user.' });
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

        // Prevent admin reset
        if (user.username === 'admin') {
            return res.render('forgot-password-verify', { user, error: 'Action not allowed for this user.' });
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

                db.query("SELECT * FROM users", (err, users) => {
                    if (err) return res.status(500).send("Database error");
                    res.render('user-directory', { users, resetAccessCode: accessCode, resetUsername: targetUser.username });
                });
            });
        } catch (error) {
            console.error("Error hashing access code:", error);
            res.status(500).send("Internal server error");
        }
    });
});


// Staff: System settings
app.get('/staff/settings', requireRole('staff'), (req, res) => {
    res.render('settings-coming-soon');
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
    db.query("UPDATE users SET status = 'active' WHERE id = ?", [targetId], (err) => {
        if (err) {
            console.error("Error canceling deletion:", err);
            return res.status(500).send("Database error");
        }
        res.redirect('/user-directory');
    });
});

// TODO(security): Implement CSRF protection for state-changing routes
app.post('/staff/approve-deletion/:id', requireRole('staff'), (req, res) => {
    const targetId = req.params.id;
    db.query("UPDATE users SET status = 'deleted' WHERE id = ? AND role = 'customer'", [targetId], (err) => {
        if (err) {
            console.error("Error approving deletion:", err);
            return res.status(500).send("Database error");
        }
        res.redirect('/user-directory');
    });
});

// TODO(security): Implement CSRF protection for state-changing routes
app.post('/admin/delete-staff/:id', requireRole('staff'), (req, res) => {
    if (req.session.username !== 'admin') {
        return res.status(403).send("Forbidden: Only the system admin can delete staff accounts.");
    }

    const targetId = req.params.id;

    // Prevent self-deletion if ID matches session (though we rely on username for the admin check)
    // To be perfectly safe, we verify we aren't targeting the admin.
    db.query("SELECT username FROM users WHERE id = ?", [targetId], (err, results) => {
        if (err || results.length === 0) return res.status(500).send("User not found.");

        if (results[0].username === 'admin') {
            return res.status(403).send("Forbidden: Cannot delete the primary admin account.");
        }

        db.query("UPDATE users SET status = 'deleted' WHERE id = ? AND role = 'staff'", [targetId], (err2) => {
            if (err2) {
                console.error("Error deleting staff:", err2);
                return res.status(500).send("Database error");
            }
            res.redirect('/user-directory');
        });
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

        db.query("UPDATE users SET status = 'deleted' WHERE id = ? AND role = 'customer'", [targetId], (err2) => {
            if (err2) {
                console.error("Error deleting customer:", err2);
                return res.status(500).send("Database error");
            }
            res.redirect('/user-directory');
        });
    });
});



// ==========================================
// PET CRUD ROUTES
// ==========================================

app.get('/addpet', requireRole('customer'), (req, res) => {
    res.render('addpet');
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
    const petPhoto = req.file ? `/uploads/pets/${req.file.filename}` : null;

    if (!petName || !petSpecies || !petBreed || !petGender || !req.body.age) {
        return res.status(400).send("Name, Species, Breed, Gender and Age are all required! <a href='/addpet'>Go back</a>");
    }
    if (isNaN(petAge) || petAge < 0 || petAge > 50) {
        return res.status(400).send("Invalid age! Age must be between 0 and 50 years. <a href='/addpet'>Go back</a>");
    }

    const sql = "INSERT INTO pets (owner_id, name, species, breed, gender, age, photo) VALUES (?, ?, ?, ?, ?, ?, ?)";
    db.query(sql, [ownerId, petName, petSpecies, petBreed, petGender, petAge, petPhoto], (err) => {
        if (err) {
            console.error("Error adding pet:", err);
            return res.status(500).send("Database error");
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
        res.render('editpet', { pet: pets[0] });
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

    if (!petName || !petSpecies || !petBreed || !petGender || !req.body.age) {
        return res.status(400).send("Name, Species, Breed, Gender and Age are all required! <a href='/pets/edit/" + petId + "'>Go back</a>");
    }
    if (isNaN(petAge) || petAge < 0 || petAge > 50) {
        return res.status(400).send("Invalid age! Age must be between 0 and 50 years. <a href='/pets/edit/" + petId + "'>Go back</a>");
    }

    db.query("SELECT photo FROM pets WHERE id = ? AND owner_id = ?", [petId, req.session.userId], (err, pets) => {
        if (err) {
            console.error("Error fetching pet:", err);
            return res.status(500).send("Database error");
        }
        if (pets.length === 0) {
            return res.status(404).send("Pet not found. <a href='/customer-dashboard'>Go back</a>");
        }

        const photoPath = req.file ? `/uploads/pets/${req.file.filename}` : pets[0].photo;
        const sql = "UPDATE pets SET name = ?, species = ?, breed = ?, gender = ?, age = ?, photo = ? WHERE id = ? AND owner_id = ?";

        db.query(sql, [petName, petSpecies, petBreed, petGender, petAge, photoPath, petId, req.session.userId], (err2) => {
            if (err2) {
                console.error("Error updating pet:", err2);
                return res.status(500).send("Database error");
            }
            res.redirect('/customer-dashboard');
        });
    });
});

// Delete pet POST
app.post('/pets/delete/:id', requireRole('customer'), (req, res) => {
    const petId = req.params.id;
    const sql = "DELETE FROM pets WHERE id = ? AND owner_id = ?";

    db.query(sql, [petId, req.session.userId], (err) => {
        if (err) {
            console.error("Error deleting pet:", err);
            return res.status(500).send("Database error");
        }
        res.redirect('/customer-dashboard');
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
            res.render('appointments_new', { pets, vets });
        });
    });
});

// Create appointment with conflict checking (single time slot)
app.post('/appointments', requireRole('customer'), (req, res) => {
    const { pet_id, vet_id, date, slot_time, reason } = req.body;

    const owner_id = req.session.userId; // logged-in customer

    if (!pet_id || !vet_id || !date || !slot_time) {
        return res.status(400).send("Pet, vet, date, and time slot are required. <a href='/appointments/new'>Go back</a>");
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
            ${statusFilter ? 'WHERE a.status = ?' : ''}
            ORDER BY a.date, a.start_time
        `;
        params = statusFilter ? [statusFilter] : [];
    } else if (req.session.role === 'staff') {
        sql = `
            SELECT a.*, p.name AS pet_name, o.name AS owner_name
            FROM appointments a
            LEFT JOIN pets p ON a.pet_id = p.id
            LEFT JOIN users o ON a.owner_id = o.id
            WHERE a.vet_id = ?
              ${statusFilter ? 'AND a.status = ?' : ''}
            ORDER BY a.date, a.start_time
        `;
        params = statusFilter ? [req.session.userId, statusFilter] : [req.session.userId];
    } else {
        return res.status(403).send("Forbidden.");
    }

    db.query(sql, params, (err, rows) => {
        if (err) {
            console.error('Fetch appointments error:', err);
            return res.status(500).send("Could not load appointments.");
        }

        res.render('appointments_index', { appointments: rows, statusFilter, isAdmin });
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
    const vet_id = req.session.userId; // the logged-in vet

    const sql = `
        UPDATE appointments
        SET status = 'completed'
        WHERE id = ? AND vet_id = ?
    `;

    db.query(sql, [appointmentId, vet_id], (err, result) => {
        if (err) {
            console.error('Complete appointment error:', err);
            return res.status(500).send("Could not mark appointment as completed.");
        }

        if (result.affectedRows === 0) {
            return res.status(404).send("Appointment not found for this vet.");
        }

        res.redirect('/appointments');
    });
});

// ==========================================
// EXPENSE TRACKING ROUTES
// ==========================================

// Fixed category list used by both the customer and staff expense views/forms
const EXPENSE_CATEGORIES = [
    'Food', 'Vet Visit', 'Medication', 'Grooming',
    'Boarding', 'Insurance', 'Toys & Accessories', 'Other'
];

// ---------- Customer: Expense log (list + totals + breakdown) ----------
app.get('/expenses', requireRole('customer'), (req, res) => {
    const ownerId = req.session.userId;

    // Optional filters: by pet and/or by category
    const petFilter = req.query.pet_id && !isNaN(req.query.pet_id) ? req.query.pet_id : '';
    const categoryFilter = EXPENSE_CATEGORIES.includes(req.query.category) ? req.query.category : '';

    const where = ['e.owner_id = ?'];
    const params = [ownerId];

    if (petFilter) {
        where.push('e.pet_id = ?');
        params.push(petFilter);
    }
    if (categoryFilter) {
        where.push('e.category = ?');
        params.push(categoryFilter);
    }

    const listSql = `
        SELECT e.*, p.name AS pet_name
        FROM expenses e
        LEFT JOIN pets p ON e.pet_id = p.id
        WHERE ${where.join(' AND ')}
        ORDER BY e.expense_date DESC, e.id DESC
    `;

    db.query(listSql, params, (err, expenses) => {
        if (err) {
            console.error("Error fetching expenses:", err);
            return res.status(500).send("Database error");
        }

        // Totals + category breakdown always reflect ALL of the customer's
        // expenses (unfiltered), so the summary cards stay stable while the
        // table below can be filtered.
        const summarySql = `
            SELECT
                COALESCE(SUM(amount), 0) AS totalAll,
                COALESCE(SUM(CASE WHEN MONTH(expense_date) = MONTH(CURDATE())
                                    AND YEAR(expense_date) = YEAR(CURDATE())
                                   THEN amount ELSE 0 END), 0) AS totalThisMonth,
                COUNT(*) AS entryCount
            FROM expenses
            WHERE owner_id = ?
        `;

        const breakdownSql = `
            SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
            FROM expenses
            WHERE owner_id = ?
            GROUP BY category
            ORDER BY total DESC
        `;

        const monthlySql = `
            SELECT DATE_FORMAT(expense_date, '%Y-%m') AS ym, COALESCE(SUM(amount), 0) AS total
            FROM expenses
            WHERE owner_id = ? AND expense_date >= DATE_SUB(CURDATE(), INTERVAL 5 MONTH)
            GROUP BY ym
            ORDER BY ym ASC
        `;

        db.query(summarySql, [ownerId], (err2, summaryRows) => {
            if (err2) {
                console.error("Error fetching expense summary:", err2);
                return res.status(500).send("Database error");
            }

            db.query(breakdownSql, [ownerId], (err3, breakdownRows) => {
                if (err3) {
                    console.error("Error fetching expense breakdown:", err3);
                    return res.status(500).send("Database error");
                }

                db.query(monthlySql, [ownerId], (err4, monthlyRows) => {
                    if (err4) {
                        console.error("Error fetching monthly expense trend:", err4);
                        return res.status(500).send("Database error");
                    }

                    db.query("SELECT id, name FROM pets WHERE owner_id = ?", [ownerId], (err5, pets) => {
                        if (err5) {
                            console.error("Error fetching pets for expense filter:", err5);
                            return res.status(500).send("Database error");
                        }

                        const topCategory = breakdownRows.length > 0 ? breakdownRows[0].category : null;

                        res.render('expenses', {
                            expenses,
                            summary: summaryRows[0],
                            breakdown: breakdownRows,
                            monthly: monthlyRows,
                            pets,
                            categories: EXPENSE_CATEGORIES,
                            petFilter,
                            categoryFilter,
                            topCategory
                        });
                    });
                });
            });
        });
    });
});

// ---------- Customer: Add expense ----------
app.get('/expenses/add', requireRole('customer'), (req, res) => {
    db.query("SELECT id, name FROM pets WHERE owner_id = ?", [req.session.userId], (err, pets) => {
        if (err) {
            console.error("Error fetching pets:", err);
            return res.status(500).send("Database error");
        }

        res.render('addExpense', {
            pets,
            categories: EXPENSE_CATEGORIES
        });
    });
});

app.post('/expenses/add', requireRole('customer'), (req, res) => {
    const { pet_id, category, description, amount, expense_date } = req.body;

    if (!category || !amount || !expense_date) {
        return res.status(400).send("Category, amount and date are required. <a href='/expenses/add'>Go back</a>");
    }
    if (!EXPENSE_CATEGORIES.includes(category)) {
        return res.status(400).send("Invalid category. <a href='/expenses/add'>Go back</a>");
    }
    if (isNaN(amount) || Number(amount) <= 0) {
        return res.status(400).send("Amount must be a positive number. <a href='/expenses/add'>Go back</a>");
    }

    // pet_id is optional (e.g. a household supply purchase not tied to one pet).
    // When provided, it must belong to the logged-in customer.
    const petIdValue = pet_id ? pet_id : null;

    const insertExpense = () => {
        const sql = `
            INSERT INTO expenses (owner_id, pet_id, category, description, amount, expense_date)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        db.query(
            sql,
            [req.session.userId, petIdValue, category, description || null, amount, expense_date],
            (err, result) => {
                if (err) {
                    console.error("Error adding expense:", err);
                    return res.status(500).send("Database error");
                }
                res.redirect('/expenses');
            }
        );
    };

    if (petIdValue) {
        db.query("SELECT id FROM pets WHERE id = ? AND owner_id = ?", [petIdValue, req.session.userId], (err, rows) => {
            if (err) {
                console.error("Error validating pet ownership:", err);
                return res.status(500).send("Database error");
            }
            if (rows.length === 0) {
                return res.status(400).send("Invalid pet selected. <a href='/expenses/add'>Go back</a>");
            }
            insertExpense();
        });
    } else {
        insertExpense();
    }
});

// ---------- Customer: Edit expense ----------
app.get('/expenses/edit/:id', requireRole('customer'), (req, res) => {
    const expenseId = req.params.id;

    db.query(
        "SELECT * FROM expenses WHERE id = ? AND owner_id = ?",
        [expenseId, req.session.userId],
        (err, rows) => {
            if (err) {
                console.error("Error fetching expense:", err);
                return res.status(500).send("Database error");
            }
            if (rows.length === 0) {
                return res.status(404).send("Expense not found. <a href='/expenses'>Go back</a>");
            }

            db.query("SELECT id, name FROM pets WHERE owner_id = ?", [req.session.userId], (err2, pets) => {
                if (err2) {
                    console.error("Error fetching pets:", err2);
                    return res.status(500).send("Database error");
                }

                res.render('editExpense', {
                    expense: rows[0],
                    pets,
                    categories: EXPENSE_CATEGORIES
                });
            });
        }
    );
});

app.post('/expenses/edit/:id', requireRole('customer'), (req, res) => {
    const expenseId = req.params.id;
    const { pet_id, category, description, amount, expense_date } = req.body;

    if (!category || !amount || !expense_date) {
        return res.status(400).send("Category, amount and date are required. <a href='/expenses/edit/" + expenseId + "'>Go back</a>");
    }
    if (!EXPENSE_CATEGORIES.includes(category)) {
        return res.status(400).send("Invalid category. <a href='/expenses/edit/" + expenseId + "'>Go back</a>");
    }
    if (isNaN(amount) || Number(amount) <= 0) {
        return res.status(400).send("Amount must be a positive number. <a href='/expenses/edit/" + expenseId + "'>Go back</a>");
    }

    const petIdValue = pet_id ? pet_id : null;

    // Guard: the expense must belong to this customer, and if a pet is chosen
    // it must also belong to this customer.
    const sql = `
        UPDATE expenses
        SET pet_id = ?, category = ?, description = ?, amount = ?, expense_date = ?
        WHERE id = ? AND owner_id = ?
          AND (? IS NULL OR ? IN (SELECT id FROM pets WHERE owner_id = ?))
    `;

    db.query(
        sql,
        [petIdValue, category, description || null, amount, expense_date,
            expenseId, req.session.userId,
            petIdValue, petIdValue, req.session.userId],
        (err, result) => {
            if (err) {
                console.error("Error updating expense:", err);
                return res.status(500).send("Database error");
            }
            if (result.affectedRows === 0) {
                return res.status(404).send("Expense not found or invalid pet selected. <a href='/expenses'>Go back</a>");
            }
            res.redirect('/expenses');
        }
    );
});

// ---------- Customer: Delete expense ----------
app.post('/expenses/delete/:id', requireRole('customer'), (req, res) => {
    const expenseId = req.params.id;

    db.query(
        "DELETE FROM expenses WHERE id = ? AND owner_id = ?",
        [expenseId, req.session.userId],
        (err) => {
            if (err) {
                console.error("Error deleting expense:", err);
                return res.status(500).send("Database error");
            }
            res.redirect('/expenses');
        }
    );
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

// ==========================================
// Start Server
// ==========================================

app.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running on http://127.0.0.1:${PORT}`);
});