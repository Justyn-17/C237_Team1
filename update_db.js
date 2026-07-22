const mysql = require('mysql');

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'c237-leonard-mysql.mysql.database.azure.com',
    user: process.env.DB_USER || 'c237_023',
    password: process.env.DB_PASSWORD || 'c237023@2026!',
    database: process.env.DB_NAME || 'c237_023_team1_petcenter',
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) {
        console.error("Connection error:", err);
        process.exit(1);
    }
    console.log("Connected to database. Running updates...");

    const createInvoices = `
        CREATE TABLE IF NOT EXISTS invoices (
            id INT AUTO_INCREMENT PRIMARY KEY,
            owner_id INT NOT NULL,
            pet_id INT NULL,
            staff_id INT NOT NULL,
            title VARCHAR(255) NOT NULL,
            category VARCHAR(50) NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            status ENUM('pending', 'paid', 'cancelled') DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            paid_at TIMESTAMP NULL,
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE SET NULL,
            FOREIGN KEY (staff_id) REFERENCES users(id)
        )
    `;

    const createNotifications = `
        CREATE TABLE IF NOT EXISTS notifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            message TEXT NOT NULL,
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `;

    const createReviews = `
        CREATE TABLE IF NOT EXISTS reviews (
            id INT AUTO_INCREMENT PRIMARY KEY,
            invoice_id INT NOT NULL,
            user_id INT NOT NULL,
            rating INT NOT NULL,
            comment TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `;

    db.query(createInvoices, (err) => {
        if (err) console.error("Error creating invoices table:", err);
        else console.log("Invoices table ready.");

        db.query(createNotifications, (err2) => {
            if (err2) console.error("Error creating notifications table:", err2);
            else console.log("Notifications table ready.");

            db.query(createReviews, (err3) => {
                if (err3) console.error("Error creating reviews table:", err3);
                else console.log("Reviews table ready.");

                console.log("Database update complete!");
                process.exit(0);
            });
        });
    });
});