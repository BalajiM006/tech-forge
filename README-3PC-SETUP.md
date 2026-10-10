# 🌐 Mend: 3-PC Distributed LAN Cluster Setup & Self-Healing Guide

This guide walks you through running Mend as a real distributed object store across **3 separate physical PCs** connected to the same Wi-Fi router or Local Area Network (LAN).

---

## 🏗️ Architecture Overview

```
                      Wi-Fi Router / LAN (Same Subnet)
                ┌───────────────────────┼───────────────────────┐
                │                       │                       │
          192.168.1.10            192.168.1.11            192.168.1.12
                │                       │                       │
                ▼                       ▼                       ▼
      ┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐
      │       PC 1        │   │       PC 2        │   │       PC 3        │
      │  (Coordinator &   │   │  (Storage Node 2) │   │  (Storage Node 3) │
      │   Storage Node 1) │   │                   │   │                   │
      ├───────────────────┤   ├───────────────────┤   ├───────────────────┤
      │ Port 5000 (Web UI)│   │ Port 5001 (Node 2)│   │ Port 5001 (Node 3)│
      │ Port 5001 (Node 1)│   └───────────────────┘   └───────────────────┘
      └───────────────────┘
```

- **Replication Factor (RF = 3):** Every uploaded file is split into 8 KB SHA-256 chunks and copied to **PC 1, PC 2, and PC 3**.
- **Quorum Writes ($W \ge 2$):** A write succeeds only when at least 2 PCs confirm the atomic write.
- **Continuous Anti-Entropy Scrubber:** PC 1's coordinator checks chunk hashes on all 3 PCs every 2.5 seconds.
- **Delta Self-Healing:** If you delete or alter a chunk on your PC, the coordinator automatically retrieves the authentic copy from the other 2 PCs and repairs your PC.

---

## 🚀 Setup Instructions

### Step 1: Connect All 3 PCs to the Same Wi-Fi
Make sure PC 1, PC 2, and PC 3 are connected to the same Wi-Fi network (or mobile hotspot).

Find each PC's IP address:
```powershell
ipconfig
```
Look for **IPv4 Address** (e.g., `192.168.1.10`, `192.168.1.11`, `192.168.1.12`).

---

### Step 2: Configure Windows Firewall
Run in PowerShell as Administrator on each PC (or click "Allow" when the Windows prompt appears):
```powershell
New-NetFirewallRule -DisplayName "Mend Cluster" -Direction Inbound -LocalPort 5000,5001 -Protocol TCP -Action Allow
```

---

### Step 3: Start Node on PC 2
On **PC 2**, you only need `storage-node.js`.
In your Command Prompt or PowerShell (e.g. `C:\Users\Admin`), run this **1-line command** (downloads the file from PC 1 and starts the node automatically):
```cmd
curl -O http://10.183.252.43:5000/storage-node.js && node storage-node.js --id pc-2 --port 5001 --zone zone-b
```
*Output: `[pc-2] Storage Node active on 0.0.0.0:5001 (Zone: zone-b)`*

---

### Step 4: Start Node on PC 3
On **PC 3**, run this **1-line command** in Command Prompt or PowerShell:
```cmd
curl -O http://10.183.252.43:5000/storage-node.js && node storage-node.js --id pc-3 --port 5001 --zone zone-c
```
*Output: `[pc-3] Storage Node active on 0.0.0.0:5001 (Zone: zone-c)`*

---

### Step 5: Start Master Coordinator on PC 1
On **PC 1** (your host machine):
```bash
npm start
```
1. Open the dashboard at:
   - **Locally:** `http://localhost:5000`
   - **From any PC or phone on Wi-Fi:** `http://<PC-1-IP>:5000`
2. Click the **"🌐 3-PC LAN Cluster"** button in the dashboard toolbar.
3. Verify or enter the IP addresses of **PC 2** and **PC 3** and click **"Apply & Connect Cluster"**.

---

## 🧪 How to Demonstrate the Self-Healing Live

### 1. Upload a File
- Drag and drop any file (e.g., `contract.pdf` or `photo.png`) onto the dashboard.
- Chunks will be replicated across PC 1, PC 2, and PC 3 simultaneously.
- Check `./data/pc-1/`, `./data/pc-2/` on PC 2, and `./data/pc-3/` on PC 3: each has matching `.dat` chunk files.

### 2. Simulate Local Data Deletion (The Test)
- On **PC 1**, go to folder `./data/pc-1/`.
- **Delete 2 or 3 of the `.dat` chunk files** (or open one in Notepad and corrupt characters inside).

### 3. Watch Self-Healing Over the Network
- Within 2.5 seconds, the scrubber challenges PC 1's chunks.
- PC 1 is flagged with **Checksum Mismatch / Missing**.
- The Coordinator contacts **PC 2** or **PC 3** over the Wi-Fi network, retrieves the authentic chunk, verifies the SHA-256 fingerprint in transit, and writes it back into PC 1 (`./data/pc-1/`).
- The dashboard log updates in real-time:
  > `[REPAIR COMPLETED] Chunk abc1234 restored to pc-1 in 45ms from peer pc-2. (Active copies: 3/3)`
- Download the file from the dashboard: it is 100% bit-for-bit intact!
