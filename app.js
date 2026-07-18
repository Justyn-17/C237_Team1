const express = require('express');
const mysql = require('mysql');
const session = require('express-session');
const crypto = require('crypto');
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
app.locals.photoPath = function(photo) {
    if (!photo) return null;
    // If it's an absolute Windows path or contains backslashes, return a safe uploads URL using the basename
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
        // Non-image files are silently skipped (req.file stays undefined) rather than
        // erroring the whole request - the pet still saves, just without a photo.
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

    // Basic SQL query to fetch pets
    // (Later, Student B will help filter this by the logged-in user's ID)
    const sql = "SELECT * FROM pets";

    db.query(sql, (err, results) => {
        if (err) {
            console.error("Error fetching pets:", err);
            return res.status(500).send("Database error");
        }

        // Normalize photo paths that may be absolute/stale (e.g., from a previous Downloads path)
        results.forEach(p => {
            if (p.photo && (p.photo.includes('\\') || /^[A-Za-z]:/.test(p.photo))) {
                p.photo = `/uploads/pets/${path.basename(p.photo)}`;
            }
        });
        // Pass the database results to the customer.ejs file
        res.render('customer', { pets: results });
    });
});

// Staff Dashboard
app.get('/staff-dashboard', (req, res) => {
    if (req.session.role !== 'staff') {
        // TODO(security): Fail closed.
        return res.status(403).send("Forbidden. Staff only. <a href='/login'>Login</a>");
    }
    res.render('staff');
});



// ==========================================
// PET CRUD ROUTES
// ==========================================

app.get('/addpet', (req, res) => {
    if (req.session.role !== 'customer') {
        return res.redirect('/login');
    }
    res.render('addpet');
});

app.post('/addpet', upload.single('photo'), (req, res) => {
    if (req.session.role !== 'customer') {
        return res.redirect('/login');
    }

    const petName = req.body.name;
    const petSpecies = req.body.species;
    let petBreed = req.body.breed;
    
    // If breed is "other", use the custom breed input
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
    db.query(sql, [ownerId, petName, petSpecies, petBreed, petGender, petAge, petPhoto], (err, result) => {
        if (err) {
            console.error("Error adding pet:", err);
            return res.status(500).send("Database error");
        }
        res.redirect('/customer-dashboard');
    });
});

// View a pet + its care records (feeding/vaccination/medication log)
// Supports filtering by type via ?type=Feeding|Vaccination|Medication
app.get('/pets/view/:id', (req, res) => {
    if (req.session.role !== 'customer') {
        return res.redirect('/login');
    }

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
            // Normalize stored photo path if it's an absolute or Windows-style path
            if (pets[0].photo && (pets[0].photo.includes('\\') || /^[A-Za-z]:/.test(pets[0].photo))) {
                pets[0].photo = `/uploads/pets/${path.basename(pets[0].photo)}`;
            }
            res.render('viewpet', { pet: pets[0], records, typeFilter });
        });
    });
});

// Add a care record (feeding/vaccination/medication) for a pet
app.post('/pets/:id/care-records', (req, res) => {
    if (req.session.role !== 'customer') {
        return res.redirect('/login');
    }

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

// Edit pet GET - Display edit form
app.get('/pets/edit/:id', (req, res) => {
    if (req.session.role !== 'customer') {
        return res.redirect('/login');
    }

    const petId = req.params.id;
    db.query("SELECT * FROM pets WHERE id = ?", [petId], (err, pets) => {
        if (err) {
            console.error("Error fetching pet:", err);
            return res.status(500).send("Database error");
        }
        if (pets.length === 0) {
            return res.status(404).send("Pet not found. <a href='/customer-dashboard'>Go back</a>");
        }
        // Normalize stored photo path if it's an absolute or Windows-style path
        if (pets[0].photo && (pets[0].photo.includes('\\') || /^[A-Za-z]:/.test(pets[0].photo))) {
            pets[0].photo = `/uploads/pets/${path.basename(pets[0].photo)}`;
        }
        res.render('editpet', { pet: pets[0] });
    });
});

// Edit pet POST - Update pet details
app.post('/pets/edit/:id', upload.single('photo'), (req, res) => {
    if (req.session.role !== 'customer') {
        return res.redirect('/login');
    }

    const petId = req.params.id;
    const petName = req.body.name;
    const petSpecies = req.body.species;
    let petBreed = req.body.breed;
    
    // If breed is "other", use the custom breed input
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

    // Get current pet to check if we need to update photo
    db.query("SELECT photo FROM pets WHERE id = ?", [petId], (err, pets) => {
        if (err) {
            console.error("Error fetching pet:", err);
            return res.status(500).send("Database error");
        }

        const photoPath = req.file ? `/uploads/pets/${req.file.filename}` : pets[0].photo;
        const sql = "UPDATE pets SET name = ?, species = ?, breed = ?, gender = ?, age = ?, photo = ? WHERE id = ?";
        
        db.query(sql, [petName, petSpecies, petBreed, petGender, petAge, photoPath, petId], (err) => {
            if (err) {
                console.error("Error updating pet:", err);
                return res.status(500).send("Database error");
            }
            res.redirect('/customer-dashboard');
        });
    });
});

// Delete pet POST
app.post('/pets/delete/:id', (req, res) => {
    if (req.session.role !== 'customer') {
        return res.redirect('/login');
    }

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



// Start Server
// TODO(security): Listening on 127.0.0.1 for testing/development as per guidelines
app.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running on http://127.0.0.1:${PORT}`);
});
