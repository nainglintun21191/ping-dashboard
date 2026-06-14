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
const CONFIG_FILE = path.join(__dirname, 'config.json');

if (!fs.existsSync(HOSTS_FILE)) fs.writeFileSync(HOSTS_FILE, JSON.stringify([], null, 2), 'utf8');
if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify({ password: "admin123" }, null, 2), 'utf8');

let hosts = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
let config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
let pingHistory = [];
const MAX_HISTORY_LOGS = 50000; 

function logStatus(hostname, ip, status) {
    const timestamp = new Date().toISOString();
    pingHistory.push({ timestamp, hostname, ip, status });
    if (pingHistory.length > MAX_HISTORY_LOGS) pingHistory.shift();
}

async function monitorHosts() {
    for (let host of hosts) {
        try {
            const res = await ping.promise.probe(host.ip, { timeout: 2, extra: ['-c', '1'] });
            const currentStatus = res.alive ? 'Online' : 'Offline';
            logStatus(host.name, host.ip, currentStatus);
            
            io.emit('status-update', { name: host.name, ip: host.ip, status: currentStatus, latency: res.time });
        } catch (err) {
            console.error(`Error pinging ${host.ip}:`, err);
        }
    }
}
setInterval(monitorHosts, 5000);

// API: List Hosts
app.get('/api/hosts', (req, res) => res.json(hosts));

// API: Verify Admin Password
app.post('/api/verify-password', (req, res) => {
    if (req.body.password === config.password) return res.json({ success: true });
    res.status(401).json({ success: false, error: "Password မှားယွင်းနေပါသည်။" });
});

// API: Change Password
app.post('/api/change-password', (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (oldPassword !== config.password) return res.status(400).json({ error: "Password အဟောင်း မှားယွင်းနေပါသည်။" });
    if (!newPassword || newPassword.trim().length < 4) return res.status(400).json({ error: "Password အသစ်သည် အနည်းဆုံး စာလုံး ၄ လုံး ရှိရပါမည်။" });
    
    config.password = newPassword.trim();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    res.json({ message: "Password ပြောင်းလဲခြင်း အောင်မြင်ပါသည်။" });
});

// API: Single Add Host
app.post('/api/hosts', (req, res) => {
    const { name, ip } = req.body;
    if (!name || !ip) return res.status(400).json({ error: "Hostname and IP are required." });
    if (hosts.some(h => h.ip === ip)) return res.status(400).json({ error: "IP Address configuration already exists." });
    
    hosts.push({ name, ip });
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2), 'utf8');
    io.emit('hosts-updated', hosts);
    res.status(201).json({ message: "Host added successfully" });
});

// API: Single Edit Host
app.put('/api/hosts/:oldIp', (req, res) => {
    const oldIp = req.params.oldIp;
    const { name, ip } = req.body;
    if (!name || !ip) return res.status(400).json({ error: "Hostname and IP are required." });
    if (oldIp !== ip && hosts.some(h => h.ip === ip)) return res.status(400).json({ error: "ပြင်ဆင်လိုက်သော IP Address သည် ရှိပြီးသား ဖြစ်နေပါသည်။" });

    const index = hosts.findIndex(h => h.ip === oldIp);
    if (index !== -1) {
        hosts[index] = { name, ip };
        fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2), 'utf8');
        io.emit('hosts-updated', hosts);
        return res.json({ message: "Host updated successfully" });
    }
    res.status(404).json({ error: "Host not found" });
});

// API: Single Delete Host
app.delete('/api/hosts/:ip', (req, res) => {
    hosts = hosts.filter(h => h.ip !== req.params.ip);
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2), 'utf8');
    io.emit('hosts-updated', hosts);
    res.json({ message: "Host deleted successfully" });
});

/* =======================================================
   NEW V3.0 FEATURE: BATCH IMPORT / EXPORT HOSTS CONFIG
   ======================================================= */

// 1. API: Export Configurations to CSV
app.get('/api/config/export-csv', (req, res) => {
    let csvContent = "Hostname,IP Address\n";
    hosts.forEach(h => {
        csvContent += `"${h.name.replace(/"/g, '""')}",${h.ip}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=Dashboard_Hosts_Backup.csv');
    res.status(200).send(csvContent);
});

// 2. API: Import Configurations from CSV
app.post('/api/config/import-csv', express.text({ type: 'text/csv', limit: '2mb' }), (req, res) => {
    const csvData = req.body;
    if (!csvData) return res.status(400).json({ error: "CSV data မတွေ့ရှိပါ။" });

    const lines = csvData.split(/\r?\n/);
    let addedCount = 0;
    let skippedCount = 0;

    // Line 0 သည် Header (Hostname,IP Address) ဖြစ်၍ Line 1 မှ စဖတ်မည်
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Comma ဖြင့် ခွဲထုတ်ခြင်း (ရိုးရှင်းသော CSV parsing)
        const parts = line.split(',');
        if (parts.length >= 2) {
            let name = parts[0].replace(/^["']|["']$/g, '').trim(); // Quote များ ဖြုတ်ပစ်ခြင်း
            let ip = parts[1].replace(/^["']|["']$/g, '').trim();

            if (name && ip) {
                // IP ထပ်နေခြင်း ရှိ/မရှိ စစ်ဆေးခြင်း Safety Check
                if (hosts.some(h => h.ip === ip)) {
                    skippedCount++;
                } else {
                    hosts.push({ name, ip });
                    addedCount++;
                }
            }
        }
    }

    if (addedCount > 0) {
        fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2), 'utf8');
        io.emit('hosts-updated', hosts);
    }

    res.json({ message: "Import လုပ်ငန်းစဉ် ပြီးဆုံးပါပြီ။", added: addedCount, skipped: skippedCount });
});

// Performance Report Preview & Export
function calculateReportData(targetIp, startTime, endTime) {
    const startMs = new Date(startTime).getTime(); const endMs = new Date(endTime).getTime();
    const filteredHistory = pingHistory.filter(log => {
        const logTime = new Date(log.timestamp).getTime();
        return log.ip === targetIp && logTime >= startMs && logTime <= endMs;
    });
    const targetHost = hosts.find(h => h.ip === targetIp) || { name: "Unknown", ip: targetIp };
    const totalDiffMs = endMs - startMs; const totalHours = (totalDiffMs / (1000 * 60 * 60)).toFixed(2);
    const totalPings = filteredHistory.length; const offlinePings = filteredHistory.filter(log => log.status === 'Offline').length;
    let totalDowntimeHours = 0, downtimePercentage = 0;
    if (totalPings > 0) {
        totalDowntimeHours = ((offlinePings / totalPings) * totalHours).toFixed(2);
        downtimePercentage = ((offlinePings / totalPings) * 100).toFixed(2);
    }
    return { hostName: targetHost.name, ip: targetIp, startTime, endTime, totalHours, totalDowntimeHours, downtimePercentage, logs: filteredHistory };
}

app.post('/api/generate-report', (req, res) => {
    res.json(calculateReportData(req.body.targetIp, req.body.startTime, req.body.endTime));
});

app.post('/api/export-csv', (req, res) => {
    const data = calculateReportData(req.body.targetIp, req.body.startTime, req.body.endTime);
    let csvContent = `Host Report For: ${data.hostName} (${data.ip})\nTotal Hours,${data.totalHours}\nTotal Down Hours,${data.totalDowntimeHours}\nDown Rate,${data.downtimePercentage}%\n\nTimestamp,Hostname,IP Address,Status\n`;
    data.logs.forEach(log => { csvContent += `${log.timestamp},"${log.hostname}",${log.ip},${log.status}\n`; });
    res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', `attachment; filename=Report_${data.hostName}.csv`);
    return res.status(200).send(csvContent);
});

server.listen(PORT, () => { console.log(`Server is running on http://localhost:${PORT}`); });
