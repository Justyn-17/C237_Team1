const mysql = require('mysql');

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'c237_vetclinic'
});

db.connect(err => {
    if (err) { console.error('Error connecting to MySQL:', err); process.exit(1); }
    console.log('Connected to MySQL...');
    
    const q1 = "SELECT MONTH(date) AS month, COUNT(*) AS count FROM appointments WHERE YEAR(date) = YEAR(CURDATE()) AND status <> 'cancelled' GROUP BY MONTH(date)";
    db.query(q1, (err, rows) => {
        if (err) console.error('Error q1:', err);
        console.log('Q1 (monthly):', rows);
        
        const q2 = "SELECT species, COUNT(*) AS count FROM pets GROUP BY species";
        db.query(q2, (err, rows2) => {
            if (err) console.error('Error q2:', err);
            console.log('Q2 (species):', rows2);
            
            const vetId = 3; // Assuming vet_id 3 exists
            const q3 = `SELECT p.species, COUNT(DISTINCT p.id) AS count
                        FROM pets p
                        JOIN appointments a ON a.pet_id = p.id
                        WHERE a.vet_id = ?
                        GROUP BY p.species`;
            db.query(q3, [vetId], (err, rows3) => {
                if (err) console.error('Error q3:', err);
                console.log('Q3 (vet species):', rows3);
                db.end();
            });
        });
    });
});
