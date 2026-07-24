const mysql = require('mysql');
const db = mysql.createConnection({host: 'c237-leonard-mysql.mysql.database.azure.com', user: 'c237_023', password: 'c237023@2026!', database: 'c237_023_team1_petcenter', ssl: { rejectUnauthorized: false }});
db.connect(e => {
    if(e) throw e;
    const addVitals = "ALTER TABLE appointments ADD COLUMN vitals_weight DECIMAL(5,2), ADD COLUMN vitals_temperature DECIMAL(5,2), ADD COLUMN vitals_observations TEXT;";
    db.query(addVitals, (err, result) => {
        if(err && err.code !== 'ER_DUP_FIELDNAME') console.error('Add Vitals Error:', err);
        else console.log('Vitals columns added or already exist.');
        
        const createTasks = "CREATE TABLE IF NOT EXISTS tasks (id INT AUTO_INCREMENT PRIMARY KEY, assigned_to INT NOT NULL, description VARCHAR(255) NOT NULL, status ENUM('incomplete', 'complete') DEFAULT 'incomplete', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);";
        db.query(createTasks, (err2, result2) => {
            if(err2) console.error('Create Tasks Error:', err2);
            else console.log('Tasks table created or already exists.');
            
            db.query("INSERT INTO tasks (assigned_to, description, status) VALUES (2, 'Review lab results for Bella', 'incomplete'), (2, 'Call back Mr. Tan regarding vaccination schedule', 'incomplete')", (err3) => {
                if(err3) console.error('Seed tasks error:', err3);
                else console.log('Tasks seeded.');
                db.end();
            });
        });
    });
});
