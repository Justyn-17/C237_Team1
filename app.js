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
            if (results.length > 0 && results[0].status !== 'active') {
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
app.get('/staff-dashboard', requireRole('staff'), (req, res) => {
    res.render('staff');
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
    const sql = `
        SELECT p.*, u.name AS owner_name
        FROM pets p
        LEFT JOIN users u ON p.owner_id = u.id
        ORDER BY p.name
    `;

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

        res.render('staff-pets', { pets: results });
    });
});

// Staff: Create user
app.post('/staff/create-user', requireRole('staff'), async (req, res) => {
    const { name, username, phone } = req.body;
    if (!name || !username || !phone) {
         return res.status(400).send("Name, username, and phone are required");
    }

    try {
        const accessCode = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 char hex
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(accessCode, salt);

        const sql = "INSERT INTO users (name, username, phone, password_hash, role, requires_password_reset) VALUES (?, ?, ?, ?, 'staff', true)";
        db.query(sql, [name, username, phone, hashedPassword], (err, result) => {
            if (err) {
                console.error("Database error during staff creation:", err);
                return res.status(500).send("Database error");
            }
            db.query("SELECT * FROM users", (err, results) => {
                if (err) return res.status(500).send("Database error");
                res.render('user-directory', { users: results, accessCode: accessCode, newUsername: username });
            });
        });
    } catch (error) {
         console.error("Error hashing password:", error);
         res.status(500).send("Internal server error");
    }
});

// Setup Password Routes
app.get('/setup-password', (req, res) => {
    if (!req.session.username) {
        return res.redirect('/login');
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
    
    const { new_password, confirm_password } = req.body;
    if (new_password !== confirm_password) {
        return res.render('setup-password', { error: "Passwords do not match." });
    }
    if (new_password.length < 8) {
        return res.render('setup-password', { error: "Password must be at least 8 characters long." });
    }
    
    try {
        const password_hash = await bcrypt.hash(new_password, 10);
        const sql = "UPDATE users SET password_hash = ?, requires_password_reset = false WHERE username = ?";
        
        db.query(sql, [password_hash, req.session.username], (err, result) => {
            if (err) {
                console.error("Database error during password setup:", err);
                return res.status(500).send("Database error");
            }
            if (req.session.role === 'staff') {
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
        req.session.destroy(() => {
            res.redirect('/login');
        });
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
app.get('/pets/view/:id', requireRole('customer'), (req, res) => {
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
app.post('/pets/:id/care-records', requireRole('customer'), (req, res) => {
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
app.get('/pets/edit/:id', requireRole('customer'), (req, res) => {
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
app.post('/pets/delete/:id', requireRole('customer'), (req, res) => {
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
// CARE REMINDERS ROUTES
// ==========================================

// Customer - View all reminders
app.get('/reminders', requireRole('customer'), (req, res) => {

    const sql = `
        SELECT reminders.*, pets.name AS pet_name
        FROM reminders
        INNER JOIN pets
        ON reminders.pet_id = pets.id
        ORDER BY due_date ASC
    `;

    db.query(sql, (err, reminders) => {

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

    db.query("SELECT id, name FROM pets", (err, pets) => {

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

    const sql = `
        INSERT INTO reminders
        (pet_id, reminder_title, due_date, status)
        VALUES (?, ?, ?, ?)
    `;

    db.query(
        sql,
        [
            pet_id,
            reminder_title,
            due_date,
            status
        ],
        (err) => {

            if (err) {
                console.error(err);
                return res.status(500).send("Database error");
            }

            res.redirect("/reminders");

        }
    );

});


// Edit Reminder Page
app.get('/reminders/edit/:id', requireRole('customer'), (req, res) => {

    const reminderId = req.params.id;

    db.query(
        "SELECT * FROM reminders WHERE id=?",
        [reminderId],
        (err, reminder) => {

            if (err) {
                console.error(err);
                return res.status(500).send("Database error");
            }

            db.query(
                "SELECT id,name FROM pets",
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

    const sql = `
        UPDATE reminders
        SET
            pet_id=?,
            reminder_title=?,
            due_date=?,
            status=?
        WHERE id=?
    `;

    db.query(
        sql,
        [
            pet_id,
            reminder_title,
            due_date,
            status,
            reminderId
        ],
        (err) => {

            if (err) {
                console.error(err);
                return res.status(500).send("Database error");
            }

            res.redirect("/reminders");

        }
    );

});


// Delete Reminder
app.post('/reminders/delete/:id', requireRole('customer'), (req, res) => {

    const reminderId = req.params.id;

    db.query(
        "DELETE FROM reminders WHERE id=?",
        [reminderId],
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
app.post('/appointments', requireRole('customer'), (req, res) => {
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
app.get('/appointments/my', requireRole('customer'), (req, res) => {
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
app.post('/appointments/:id/cancel', requireRole('customer'), (req, res) => {
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
app.post('/appointments/:id/complete', requireRole('staff'), (req, res) => {
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