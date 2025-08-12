const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const http = require('http');
const WebSocket = require('ws');

// Load environment variables
dotenv.config();

// Import custom modules
const logger = require('./utils/logger');
const binaryManager = require('./services/binaryManager');
const deviceManager = require('./services/newDeviceManager');
const updateManager = require('./services/updateManager');
const { authMiddleware, authManager } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');

// Import routes
const deviceRoutes = require('./routes/devices');
const healthRoutes = require('./routes/health');
const docsRoutes = require('./routes/docs');

// Import new direct API routes
const appRoutes = require('./routes/app');
const sendRoutes = require('./routes/send');
const userRoutes = require('./routes/user');
const messageApiRoutes = require('./routes/message');
const chatRoutes = require('./routes/chat');
const groupRoutes = require('./routes/group');
const newsletterRoutes = require('./routes/newsletter');

class APIGateway {
  constructor() {
    console.log('🏗️ Iniciando constructor...');
    this.app = express();
    this.server = http.createServer(this.app);
    this.port = process.env.API_PORT || 3000;
    console.log('✅ Express e server criados');
    
    console.log('⚙️ Configurando middleware...');
    this.setupMiddleware();
    console.log('✅ Middleware configurado');
    
    console.log('🛣️ Configurando rotas...');
    this.setupRoutes();
    console.log('✅ Rotas configuradas');
    
    console.log('🔌 Configurando WebSocket...');
    this.setupWebSocket();
    console.log('✅ WebSocket configurado');
    
    console.log('❌ Configurando error handling...');
    this.setupErrorHandling();
    console.log('✅ Error handling configurado');
    console.log('🎉 Constructor finalizado!');
  }

  setupMiddleware() {
    // Security middleware
    this.app.use(helmet());
    this.app.use(cors());

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: process.env.API_RATE_LIMIT || 100,
      message: 'Muitas requisições deste IP, tente novamente em 15 minutos.'
    });
    this.app.use(limiter);

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Logging
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path} - ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    // Public routes
    this.app.use('/api/health', healthRoutes);
    this.app.use('/docs', docsRoutes);

    // Protected routes
    this.app.use('/api', authMiddleware);

    this.app.use('/api/devices', deviceRoutes);
    
    // New direct API routes with instance_id support
    this.app.use('/api/app', appRoutes);
    this.app.use('/api/send', sendRoutes);
    this.app.use('/api/user', userRoutes);
    this.app.use('/api/message', messageApiRoutes);
    this.app.use('/api/chat', chatRoutes);
    this.app.use('/api/chats', chatRoutes);
    this.app.use('/api/group', groupRoutes);
    this.app.use('/api/newsletter', newsletterRoutes);

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        name: 'WhatsApp Multi-Platform API Gateway',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString(),
        endpoints: {
          devices: '/api/devices',
          app: '/api/app',
          send: '/api/send',
          user: '/api/user',
          message: '/api/message',
          chat: '/api/chat',
          group: '/api/group',
          health: '/api/health',
          docs: '/docs'
        },
        links: {
          documentation: '/docs',
          openapi_yaml: '/docs/openapi.yaml',
          'openapi_json': '/docs/openapi.json',
          postman_collection: '/docs/postman',
          'regenerate_docs': '/docs/generate'
        }
      });
    });
  }


  setupWebSocket() {
    // Create WebSocket server
    this.wss = new WebSocket.Server({ 
      server: this.server,
      path: '/ws'
    });

    this.wss.on('connection', (ws, req) => {
      logger.info(`WebSocket client connected: ${req.socket.remoteAddress}`);

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Connected to WhatsApp Gateway WebSocket',
        timestamp: new Date().toISOString()
      }));

      // Handle messages from client
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          logger.info(`WebSocket message received:`, message);
          
          // Handle different message types
          if (message.type === 'join-device') {
            ws.deviceFilter = message.deviceHash;
            ws.send(JSON.stringify({
              type: 'joined-device',
              deviceHash: message.deviceHash,
              timestamp: new Date().toISOString()
            }));
          } else {
            // Echo back for other messages
            ws.send(JSON.stringify({
              type: 'echo',
              originalMessage: message,
              timestamp: new Date().toISOString()
            }));
          }
        } catch (error) {
          logger.error('Error parsing WebSocket message:', error);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid JSON message',
            timestamp: new Date().toISOString()
          }));
        }
      });

      ws.on('close', (code, reason) => {
        logger.info(`WebSocket client disconnected: ${code} ${reason}`);
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });

    // Make WebSocket server available globally
    global.webSocketServer = this.wss;
    
    logger.info('WebSocket server configured on path /ws');
  }

  setupErrorHandling() {
    this.app.use(errorHandler);

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Endpoint não encontrado',
        path: req.originalUrl,
        method: req.method
      });
    });
  }

  async start() {
    try {
      // Initialize services in correct order
      console.log('🔐 Inicializando authManager...');
      await authManager.initialize();
      console.log('✅ authManager inicializado');

      console.log('📱 Inicializando deviceManager...');
      await deviceManager.initialize();
      console.log('✅ deviceManager inicializado');
      
      console.log('📦 Inicializando binaryManager...');
      await binaryManager.initialize();
      console.log('✅ binaryManager inicializado');

      // Initialize Update Manager (non-async)
      console.log('🔄 Inicializando updateManager...');
      updateManager.initialize();
      console.log('✅ updateManager inicializado');

      // Start server last
      this.server.listen(this.port, () => {
        logger.info(`🚀 API Gateway rodando na porta ${this.port}`);
        logger.info(`📊 Ambiente: ${process.env.NODE_ENV || 'development'}`);
        logger.info(`🔐 Autenticação: ${process.env.API_AUTH_ENABLED === 'true' ? 'Ativada' : 'Desativada'}`);
        logger.info(`🔄 Verificações de atualização: ${process.env.UPDATE_CHECK_CRON || '0 2 * * *'}`);
        logger.info('✅ Todos os serviços inicializados com sucesso!');
      });

      // Graceful shutdown
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());

    } catch (error) {
      logger.error('Erro ao inicializar API Gateway:', error);
      console.error('ERRO CRÍTICO:', error.message);
      console.error('STACK:', error.stack);
      process.exit(1);
    }
  }

  async shutdown() {
    logger.info('Iniciando shutdown graceful...');
    
    try {
      // Stop update manager
      updateManager.stop();
      
      // Close server
      this.server.close(() => {
        logger.info('Servidor HTTP fechado');
      });

      // Cleanup processes
      await binaryManager.cleanup();
      
      logger.info('Shutdown concluído');
      process.exit(0);
    } catch (error) {
      logger.error('Erro durante shutdown:', error);
      process.exit(1);
    }
  }
}

// Initialize and start the API Gateway
console.log('🏗️ Criando instância do APIGateway...');
const gateway = new APIGateway();
console.log('✅ Instância criada, iniciando start()...');
gateway.start();

module.exports = gateway;