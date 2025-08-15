# 📚 Documentação do WhatsApp Multi-Platform API Gateway

## 📋 Índice da Documentação

### 🏗️ Arquitetura e Conceitos
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Arquitetura técnica do sistema
- **[DEVICE_SECURITY.md](./DEVICE_SECURITY.md)** - Segurança e identificação por deviceHash
- **[ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)** - Variáveis de ambiente completas

### 🔄 APIs e Integrações
- **[API_DOCUMENTATION.md](./API_DOCUMENTATION.md)** - Documentação completa das APIs
- **[WEBHOOK_STATUS.md](./WEBHOOK_STATUS.md)** - Sistema de webhooks de status
- **[openapi.yaml](./openapi.yaml)** - Especificação OpenAPI/Swagger
- **[openapi.json](./openapi.json)** - Especificação OpenAPI (JSON)

### 🐳 Deploy e Infraestrutura
- **[DOCKER_DEPLOY.md](./DOCKER_DEPLOY.md)** - Deploy automático para Docker Hub
- **[DOCKER_HUB_SETUP.md](./DOCKER_HUB_SETUP.md)** - Configuração do GitHub Actions

### 🗺️ Planejamento e Histórico
- **[ROADMAP.md](./ROADMAP.md)** - Roadmap de funcionalidades
- **[CHANGELOG.md](./CHANGELOG.md)** - Histórico de mudanças

## 🚀 Links Rápidos

### APIs Disponíveis
- **Swagger UI**: `http://localhost:3000/docs`
- **OpenAPI YAML**: `http://localhost:3000/docs/openapi.yaml`
- **Health Check**: `http://localhost:3000/api/health`

### Principais Endpoints
```bash
# Registrar dispositivo
POST /api/devices

# Obter QR code
GET /api/login
Header: x-instance-id: {deviceHash}

# Enviar mensagem
POST /api/send/message
Header: x-instance-id: {deviceHash}
```

## 📁 Estrutura do Projeto

```
docs/
├── README.md                 # Este arquivo (índice)
├── API_DOCUMENTATION.md      # Docs das APIs
├── ARCHITECTURE.md           # Arquitetura técnica
├── DEVICE_SECURITY.md        # Segurança deviceHash
├── WEBHOOK_STATUS.md         # Sistema de webhooks
├── DOCKER_DEPLOY.md          # Deploy Docker Hub
├── DOCKER_HUB_SETUP.md       # Setup GitHub Actions
├── ROADMAP.md                # Roadmap funcionalidades
├── CHANGELOG.md              # Histórico mudanças
├── openapi.yaml              # Especificação OpenAPI
└── openapi.json              # Especificação OpenAPI (JSON)
```

## 📖 Como Usar Esta Documentação

1. **Iniciantes**: Comece com [ARCHITECTURE.md](./ARCHITECTURE.md)
2. **Desenvolvedores**: Vá direto para [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)
3. **DevOps**: Consulte [DOCKER_DEPLOY.md](./DOCKER_DEPLOY.md)
4. **Segurança**: Leia [DEVICE_SECURITY.md](./DEVICE_SECURITY.md)

---

*Documentação organizada e centralizada - Projeto WhatsApp Multi-Platform API Gateway*