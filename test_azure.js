const mysql = require('mysql');

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'c237-leonard-mysql.mysql.database.azure.com',
    user: process.env.DB_USER || 'c237_023',
    password: process.env.DB_PASSWORD || 'c237023@2026!',
    database: process.env.DB_NAME || 'c237_023_team1_petcenter',
    ssl: { rejectUnauthorized: false }
});

db.connect(err => {
    if (err) { console.error('Error connecting:', err); process.exit(1); }
    console.log('Connected to Azure MySQL.');
    
    // Verify pie chart (total pets)
    db.query("SELECT COUNT(*) as total FROM pets", (err, petsTotal) => {
        console.log("Total Pets in DB:", petsTotal[0].total);
        
        db.query("SELECT species, COUNT(*) AS count FROM pets GROUP BY species", (err, speciesRows) => {
            const breakdown = [0, 0, 0, 0, 0]; // Dogs, Cats, Birds, Rabbits, Other
            speciesRows.forEach(row => {
                const species = (row.species || "").toLowerCase().trim();
                const count = row.count;
                if (species === 'dog' || species === 'dogs') breakdown[0] += count;
                else if (species === 'cat' || species === 'cats') breakdown[1] += count;
                else if (species === 'bird' || species === 'birds') breakdown[2] += count;
                else if (species === 'rabbit' || species === 'rabbits') breakdown[3] += count;
                else breakdown[4] += count;
            });
            const sum = breakdown.reduce((a, b) => a + b, 0);
            console.log("Pie Chart sum:", sum, breakdown);
            
            // Verify monthly appointments
            db.query("SELECT COUNT(*) as total FROM appointments WHERE YEAR(date) = YEAR(CURDATE()) AND status <> 'cancelled'", (err, apptsTotal) => {
                console.log("Total Appointments (not cancelled, this year):", apptsTotal[0].total);
                
                db.query("SELECT MONTH(date) AS month, COUNT(*) AS count FROM appointments WHERE YEAR(date) = YEAR(CURDATE()) AND status <> 'cancelled' GROUP BY MONTH(date)", (err, monthlyRows) => {
                    const monthly = Array(12).fill(0);
                    monthlyRows.forEach(row => {
                        if (row.month >= 1 && row.month <= 12) monthly[row.month - 1] = row.count;
                    });
                    const sumAppts = monthly.reduce((a, b) => a + b, 0);
                    console.log("Bar Chart sum:", sumAppts, monthly);
                    db.end();
                });
            });
        });
    });
});
