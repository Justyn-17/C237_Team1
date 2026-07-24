const fetch = require('node-fetch'); // wait node 18+ has native fetch

async function run() {
    try {
        const response = await fetch('http://127.0.0.1:3000/vet/api/appointments/23/vitals', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': 'connect.sid=fake_session' // won't work, requires role
            },
            body: JSON.stringify({
                weight: '15.5',
                temperature: '38.5',
                observations: 'test'
            })
        });
        const text = await response.text();
        console.log(response.status, text);
    } catch (e) {
        console.error(e);
    }
}
run();
