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
    next();
});

// Simple role guards to avoid random re-logins
function requireCustomer(req, res, next) {
    if (req.session.role !== 'customer') {
        return res.redirect('/login');
    }
    next();
}

function requireStaff(req, res, next) {
    if (req.session.role !== 'staff') {
        return res.redirect('/login');
    }
    next();
}

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

// Login Logic (dummy)
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
app.get('/customer-dashboard', requireCustomer, (req, res) => {
    const sql = "SELECT * FROM pets";

    db.query(sql, (err, results) => {
        if (err) {
            console.error("Error fetching pets:", err);
            return res.status(500).send("Database error");
        }

        results.forEach(p => {
            if (p.photo && (p.photo.includes('\\') || /^[A-Za-z]:/.test(p.photo))) {
                p.photo = `/uploads/pets/${path.basename(p.photo)}`;
            }
        });

        res.render('customer', { pets: results });
    });
});

// Staff Dashboard
app.get('/staff-dashboard', requireStaff, (req, res) => {
    res.render('staff');
});

// Staff: View user directory (placeholder)
app.get('/staff/users', requireStaff, (req, res) => {
    res.send("User directory coming soon.");
});

// Staff: System settings (placeholder)
app.get('/staff/settings', requireStaff, (req, res) => {
    res.send("System settings coming soon.");
});

// ==========================================
// PET CRUD ROUTES
// ==========================================

app.get('/addpet', requireCustomer, (req, res) => {
    res.render('addpet');
});

app.post('/addpet', requireCustomer, upload.single('photo'), (req, res) => {
    const petName = req.body.name;
    const petSpecies = req.body.species;
    let petBreed = req.body.breed;
    if (petBreed === 'other') {
        petBreed = req.body.customBreed;
    }

    const petGender = req.body.gender;
    const petAge = parseFloat(req.body.age);
    const ownerId = 1;
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
app.get('/pets/view/:id', requireCustomer, (req, res) => {
    const petId = req.params.id;
    const CARE_RECORD_TYPES = ['Feeding', 'Vaccination', 'Medication'];
    const typeFilter = CARE_RECORD_TYPES.includes(req.query.type) ? req.query.type : null;

    db.query("SELECT * FROM pets WHERE id = ?", [petId], (err, pets) => {
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
app.post('/pets/:id/care-records', requireCustomer, (req, res) => {
    const petId = req.params.id;
    const recordType = req.body.record_type;
    const description = req.body.description;
    const recordDate = req.body.record_date;

    if (!recordType || !recordDate) {
        return res.status(400).send("Record type and date are required! <a href='/pets/view/" + petId + "'>Go back</a>");
    }

    const sql = "INSERT INTO care_records (pet_id, record_type, description, record_date) VALUES (?, ?, ?, ?)";
    db.query(sql, [petId, recordType, description, recordDate], (err) => {
        if (err) {
            console.error("Error adding care record:", err);
            return res.status(500).send("Database error");
        }
        res.redirect(`/pets/view/${petId}`);
    });
});

// Edit pet GET
app.get('/pets/edit/:id', requireCustomer, (req, res) => {
    const petId = req.params.id;
    db.query("SELECT * FROM pets WHERE id = ?", [petId], (err, pets) => {
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
app.post('/pets/edit/:id', requireCustomer, upload.single('photo'), (req, res) => {
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

    db.query("SELECT photo FROM pets WHERE id = ?", [petId], (err, pets) => {
        if (err) {
            console.error("Error fetching pet:", err);
            return res.status(500).send("Database error");
        }

        const photoPath = req.file ? `/uploads/pets/${req.file.filename}` : pets[0].photo;
        const sql = "UPDATE pets SET name = ?, species = ?, breed = ?, gender = ?, age = ?, photo = ? WHERE id = ?";

        db.query(sql, [petName, petSpecies, petBreed, petGender, petAge, photoPath, petId], (err2) => {
            if (err2) {
                console.error("Error updating pet:", err2);
                return res.status(500).send("Database error");
            }
            res.redirect('/customer-dashboard');
        });
    });
});

// Delete pet POST
app.post('/pets/delete/:id', requireCustomer, (req, res) => {
    const petId = req.params.id;
    const sql = "DELETE FROM pets WHERE id = ?";

    db.query(sql, [petId], (err) => {
        if (err) {
            console.error("Error deleting pet:", err);
            return res.status(500).send("Database error");
        }
        res.redirect('/customer-dashboard');
    });
});

// ==========================================
// APPOINTMENTS ROUTES
// ==========================================

// New appointment form – fetch pets for dropdown
app.get('/appointments/new', requireCustomer, (req, res) => {
    const sql = "SELECT id, name, species, breed FROM pets";

    db.query(sql, (err, pets) => {
        if (err) {
            console.error("Error fetching pets for appointments:", err);
            return res.status(500).send("Database error");
        }
        res.render('appointments_new', { pets });
    });
});

// Create appointment with conflict checking (single time slot)
app.post('/appointments', requireCustomer, (req, res) => {
    const { pet_id, date, slot_time, reason } = req.body;

    const owner_id = 1; // demo customer
    const vet_id = 2;   // demo vet

    if (!pet_id || !date || !slot_time) {
        return res.status(400).send("Pet, date, and time slot are required. <a href='/appointments/new'>Go back</a>");
    }

    const start_time = slot_time;
    const end_time = slot_time;

    const conflictSql = `
        SELECT id
        FROM appointments
        WHERE vet_id = ?
          AND date = ?
          AND NOT (end_time <= ? OR start_time >= ?)
    `;

    db.query(conflictSql, [vet_id, date, start_time, end_time], (err, rows) => {
        if (err) {
            console.error('Conflict check error:', err);
            return res.status(500).send("Unexpected error while checking availability. <a href='/appointments/new'>Go back</a>");
        }

        if (rows.length > 0) {
            return res.status(400).send("This time slot is already booked for this vet. <a href='/appointments/new'>Choose another slot</a>");
        }

        const insertSql = `
            INSERT INTO appointments (pet_id, owner_id, vet_id, date, start_time, end_time, reason, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'booked')
        `;
        db.query(
            insertSql,
            [pet_id, owner_id, vet_id, date, start_time, end_time, reason],
            (err2) => {
                if (err2) {
                    console.error('Insert appointment error:', err2);
                    return res.status(500).send("Could not book appointment. <a href='/appointments/new'>Try again</a>");
                }

                res.redirect('/appointments/my');
            }
        );
    });
});

// Customer-specific list: appointments I've booked
app.get('/appointments/my', requireCustomer, (req, res) => {
    const owner_id = 1;

    const sql = `
        SELECT a.id, a.date, a.start_time, a.end_time, a.status, a.reason,
               p.name AS pet_name, p.species AS pet_species
        FROM appointments a
        JOIN pets p ON a.pet_id = p.id
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

    let sql;
    let params;

    if (req.session.role === 'customer') {
        sql = `
            SELECT *
            FROM appointments
            ORDER BY date, start_time
        `;
        params = [];
    } else if (req.session.role === 'staff') {
        sql = `
            SELECT *
            FROM appointments
            WHERE vet_id = ?
            ORDER BY date, start_time
        `;
        params = [2];
    } else {
        return res.status(403).send("Forbidden.");
    }

    db.query(sql, params, (err, rows) => {
        if (err) {
            console.error('Fetch appointments error:', err);
            return res.status(500).send("Could not load appointments.");
        }

        res.render('appointments_index', { appointments: rows });
    });
});

// Customer cancels one of their own appointments
app.post('/appointments/:id/cancel', requireCustomer, (req, res) => {
    const appointmentId = req.params.id;
    const owner_id = 1; // TODO: use real logged-in user id

    const sql = `
        UPDATE appointments
        SET status = 'cancelled'
        WHERE id = ? AND owner_id = ?
    `;

    db.query(sql, [appointmentId, owner_id], (err, result) => {
        if (err) {
            console.error('Cancel appointment error:', err);
            return res.status(500).send("Could not cancel appointment.");
        }

        if (result.affectedRows === 0) {
            return res.status(404).send("Appointment not found or not owned by you.");
        }

        res.redirect('/appointments/my');
    });
});

// Staff marks appointment as completed
app.post('/appointments/:id/complete', requireStaff, (req, res) => {
    const appointmentId = req.params.id;
    const vet_id = 2; // demo vet id

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
// Start Server
// ==========================================

app.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running on http://127.0.0.1:${PORT}`);
});