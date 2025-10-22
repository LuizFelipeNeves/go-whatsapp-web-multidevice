# 🚀 WhatsApp Multi-Platform API Gateway

> Enterprise-grade solution for managing multiple WhatsApp instances through a unified REST API

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-20+-blue.svg)](https://docker.com/)
[![Go](https://img.shields.io/badge/Go-1.21+-blue.svg)](https://golang.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## ⚠️ Importante

Este projeto funciona como uma ponte para o projeto original [go-whatsapp-web-multidevice](https://github.com/aldinokemal/go-whatsapp-web-multidevice), estendendo suas funcionalidades para suportar múltiplas instâncias. Todos os créditos da implementação base do WhatsApp Web pertencem ao projeto original.

## 📋 Overview

The **WhatsApp Multi-Platform API Gateway** is a robust and scalable solution for managing multiple WhatsApp devices simultaneously through isolated processes. Each WhatsApp instance runs as a separate process with persistent sessions, ensuring complete isolation and maximum availability.

### 🌟 Key Features

- ✅ **Multi-Device Support** - Manage unlimited WhatsApp instances
- ✅ **Process Isolation** - Each device runs in a separate process with its own session
- ✅ **Persistent Sessions** - Data saved in dedicated volumes per instance
- ✅ **Complete REST API** - Endpoints for all WhatsApp operations
- ✅ **Device Hash Security** - Auto-generated unique identifiers for privacy
- ✅ **Health Monitoring** - Automatic health checks and process control
- ✅ **Auto-Recovery** - Intelligent session restoration after restarts
- ✅ **QR Code API** - QR codes served directly as base64
- ✅ **Real-time WebSockets** - Live message mirroring and status updates
- ✅ **Enterprise Ready** - Built for production environments

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│   API Gateway    │    │   Device Manager   │    │  WhatsApp Processes │
│  (Port 3000)     │◄──►│   Process Control  │◄──►│   (Port 8000+)      │
│  • REST API      │    │   • Auto-restart   │    │   • Isolated        │
│  • Authentication│    │   • Health Checks  │    │   • Persistent      │
│  • Rate Limiting │    │   • Session Mgmt   │    │   • Device Hash ID  │
└─────────────────┘    └──────────────────┘    └─────────────────────┘
         │                       │                         │
         ▼                       ▼                         ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│   SQLite DB     │    │   WebSocket      │    │   Session Storage   │
│   Device Info   │    │   Real-time      │    │   Per Device        │
│   Status Track  │    │   Event Stream   │    │   Persistent        │
└─────────────────┘    └──────────────────┘    └─────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- **Docker** 20.10+
- **Docker Compose** 2.0+
- **4GB RAM** minimum
- **10GB** disk space

### Installation

```bash
# Clone the repository
git clone https://github.com/LuizFelipeNeves/go-whatsapp-web-multidevice.git
cd go-whatsapp-web-multidevice

# Configure environment
cp .env.example .env
nano .env  # Edit your settings

# Start the platform
docker-compose up -d
```

### Essential Configuration

```env
# .env file
API_PORT=3000
DEFAULT_ADMIN_USER=admin
DEFAULT_ADMIN_PASS=your_secure_password_here
SERVER_URL=http://localhost:3000
```

### First Steps

1. **Access API**: http://localhost:3000
2. **Login**: `POST /api/auth/login`
3. **Register Device**: `POST /api/devices`
4. **Get QR Code**: `GET /api/login` with `x-instance-id` header

## 📖 Documentation

### 📁 Complete Documentation - [docs/ folder](docs/)

- 🚀 [**Getting Started**](docs/GETTING_STARTED.md) - Quick start guide for new users
- 📚 [**API Reference**](docs/API_DOCUMENTATION.md) - Complete API guide
- 🏗️ [**Architecture**](docs/ARCHITECTURE.md) - Technical system architecture  
- 🔐 [**Security**](docs/DEVICE_SECURITY.md) - Device hash security model
- 📡 [**Webhooks**](docs/WEBHOOK_STATUS.md) - Real-time status webhooks
- 🐳 [**Deployment**](docs/DOCKER_DEPLOY.md) - Production deployment guide
- ⚙️ [**Environment Variables**](docs/ENVIRONMENT_VARIABLES.md) - Configuration options

## 💡 API Examples

### Device Registration

```bash
# 1. Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your_password"}'

# 2. Register new device
curl -X POST http://localhost:3000/api/devices \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "https://yoursite.com/webhook",
    "statusWebhookUrl": "https://yoursite.com/status"
  }'

# Response: {"deviceHash": "a1b2c3d4e5f67890", "status": "registered"}
```

### QR Code & Connection

```bash
# Get QR code for device connection
curl -X GET http://localhost:3000/api/login \
  -H "Authorization: Bearer <token>" \
  -H "x-instance-id: a1b2c3d4e5f67890"

# Response: {"qrCode": "data:image/png;base64,iVBORw0KGgoA..."}
```

### Send Messages

```bash
# Send text message
curl -X POST http://localhost:3000/api/send/message \
  -H "Authorization: Bearer <token>" \
  -H "x-instance-id: a1b2c3d4e5f67890" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+5511999999999@s.whatsapp.net",
    "message": "Hello! How can I help you?"
  }'

# Send image
curl -X POST http://localhost:3000/api/send/image \
  -H "Authorization: Bearer <token>" \
  -H "x-instance-id: a1b2c3d4e5f67890" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+5511999999999@s.whatsapp.net",
    "image": "https://example.com/image.jpg",
    "caption": "Check this out!"
  }'
```

### Real-time WebSocket

```javascript
const socket = io('http://localhost:3000');

// Listen to all device events
socket.on('whatsapp-websocket-message', (data) => {
  console.log(`Message from ${data.deviceHash}:`, data.message);
  
  if (data.message.type === 'qr') {
    showQRCode(data.deviceHash, data.message.qr);
  } else if (data.message.type === 'ready') {
    markDeviceAsReady(data.deviceHash);
  } else if (data.message.type === 'message') {
    handleIncomingMessage(data.deviceHash, data.message);
  }
});

// Monitor specific device
const monitorDevice = (deviceHash) => {
  socket.emit('join', `device-${deviceHash}`);
  
  socket.on('device-websocket-message', (data) => {
    updateDeviceStatus(deviceHash, data.message);
  });
};
```

## 📊 Monitoring & Health

### Health Checks

```bash
# System health
curl http://localhost:3000/api/health

# Detailed system status
curl http://localhost:3000/api/health/detailed

# Device status
curl -H "x-instance-id: a1b2c3d4e5f67890" \
     http://localhost:3000/api/devices/info
```

### Logs

```bash
# View all logs
docker-compose logs -f

# API Gateway only
docker-compose logs -f api-gateway
```

## ⚙️ Configuration

### Key Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `API_PORT` | API Gateway port | `3000` |
| `DEFAULT_ADMIN_USER` | Admin username | `admin` |
| `DEFAULT_ADMIN_PASS` | Admin password | `admin` |
| `PROCESS_BASE_PORT` | Starting port for processes | `8000` |
| `MAX_PROCESSES` | Maximum concurrent processes | `50` |
| `API_RATE_LIMIT` | Request rate limit | `100` |

See [Environment Variables Documentation](docs/ENVIRONMENT_VARIABLES.md) for complete list.

## 🚀 Production Ready

This system is designed for production environments with:

- **Auto-recovery** - Automatic session restoration after restarts
- **Health monitoring** - Built-in health checks and status monitoring  
- **Rate limiting** - Request throttling and abuse protection
- **Secure authentication** - JWT-based API authentication
- **Process isolation** - Each device runs in isolated process
- **Persistent storage** - Sessions survive container restarts

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- 📖 [Documentation](docs/)
- 🐛 [Report Issues](https://github.com/your-username/go-whatsapp-web-multidevice/issues)
- 💬 [Discussions](https://github.com/your-username/go-whatsapp-web-multidevice/discussions)

---

<div align="center">

**⭐ Star this project if you find it useful!**

Built for scalable WhatsApp automation

</div>
