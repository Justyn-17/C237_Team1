const http = require('http');

const data = JSON.stringify({
    weight: '15.5',
    temperature: '38.5',
    observations: 'test'
});

const req = http.request({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/vet/api/appointments/23/vitals',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Cookie': 'connect.sid=s%3ASOME_FAKE_SESSION_ID.SIGNATURE' // We'll just test the route handler logic
    }
}, res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => console.log('Response:', res.statusCode, body));
});

req.on('error', e => console.error(e));
req.write(data);
req.end();
