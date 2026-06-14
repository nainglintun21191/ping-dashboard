const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const ping = require('ping');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(express.static('public'));
app.use(express.json());

const HOSTS_FILE = path.join(__dirname, 'hosts.json');

// hosts.json မရှိရင် Auto ဆောက်ပေးမည့် Safety Logic
if (!fs.existsSync(HOSTS_FILE)) {
    fs.writeFileSync(HOSTS_FILE, JSON.stringify([], null, 2), 'utf8');
}

let hosts = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
let pingHistory = [];
const MAX_HISTORY_LOGS = 50000; 

function logStatus(hostname, ip, status) {
    const timestamp = new Date().toISOString();
    pingHistory.push({ timestamp, hostname, ip, status });
    if (pingHistory.length > MAX_HISTORY_LOGS) {
        pingHistory.shift();
    }
}

async function monitorHosts() {
    for (let host of hosts) {
        try {
            const res = await ping.promise.probe(host.ip, {
                timeout: 2,
                extra: ['-c', '1']
            });
            const currentStatus = res.alive ? 'Online' : 'Offline';
            logStatus(host.name, host.ip, currentStatus);
            
            io.emit('status-update', {
                name: host.name,
                ip: host.ip,
                status: currentStatus,
                latency: res.time
            });
        } catch (err) {
            console.error(`Error pinging ${host.ip}:`, err);
        }
    }
}

// ၅ စက္ကန့်လျှင် တစ်ကြိမ် Ping စစ်မည်
setInterval(monitorHosts, 5000);

// API: Get Host List
app.get('/api/hosts', (req, res) => {
    res.json(hosts);
});

// API: Add New Host
app.post('/api/hosts', (req, res) => {
    const { name, ip } = req.body;
    if (!name || !ip) {
        return res.status(400).json({ error: "Hostname and IP are required." });
    }
    if (hosts.some(h => h.ip === ip)) {
        return res.status(400).json({ error: "IP Address already exists." });
    }
    hosts.push({ name, ip });
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2), 'utf8');
    io.emit('hosts-updated', hosts);
    res.status(201).json({ message: "Host added successfully" });
});

// API: Delete Host
app.delete('/api/hosts/:ip', (req, res) => {
    const targetIp = req.params.ip;
    hosts = hosts.filter(h => h.ip !== targetIp);
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2), 'utf8');
    io.emit('hosts-updated', hosts);
    res.json({ message: "Host deleted successfully" });
});

// Report Calculation Core Logic
function calculateReportData(targetIp, startTime, endTime) {
    const startMs = new Date(startTime).getTime();
    const endMs = new Date(endTime).getTime();
    const filteredHistory = pingHistory.filter(log => {
        const logTime = new Date(log.timestamp).getTime();
        return log.ip === targetIp && logTime >= startMs && logTime <= endMs;
    });
    const targetHost = hosts.find(h => h.ip === targetIp) || { name: "Unknown", ip: targetIp };
    const totalDiffMs = endMs - startMs;
    const totalHours = (totalDiffMs / (1000 * 60 * 60)).toFixed(2);
    const totalPings = filteredHistory.length;
    const offlinePings = filteredHistory.filter(log => log.status === 'Offline').length;
    
    let totalDowntimeHours = 0, downtimePercentage = 0;
    if (totalPings > 0) {
        totalDowntimeHours = ((offlinePings / totalPings) * totalHours).toFixed(2);
        downtimePercentage = ((offlinePings / totalPings) * 100).toFixed(2);
    }
    return { hostName: targetHost.name, ip: targetIp, startTime, endTime, totalHours, totalDowntimeHours, downtimePercentage, logs: filteredHistory };
}

app.post('/api/generate-report', (req, res) => {
    const { targetIp, startTime, endTime } = req.body;
    res.json(calculateReportData(targetIp, startTime, endTime));
});

app.post('/api/export-csv', (req, res) => {
    const { targetIp, startTime, endTime } = req.body;
    const data = calculateReportData(targetIp, startTime, endTime);
    let csvContent = `Host Report For: ${data.hostName} (${data.ip})\nTotal Hours,${data.totalHours}\nTotal Down Hours,${data.totalDowntimeHours}\nDown Rate,${data.downtimePercentage}%\n\nTimestamp,Hostname,IP Address,Status\n`;
    data.logs.forEach(log => { csvContent += `${log.timestamp},"${log.hostname}",${log.ip},${log.status}\n`; });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=Report_${data.hostName}.csv`);
    return res.status(200).send(csvContent);
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
