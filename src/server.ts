
import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import http from 'http';
import WebSocket from 'ws';

// Load environment variables
dotenv.config();

// Import custom modules

import logger from './utils/logger';
import binaryManager from './services/binaryManager';
import deviceManager from './services/newDeviceManager';
import updateManager from './services/updateManager';
import backupManager from './services/backupManager';
import { authMiddleware, authManager } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';

// Import routes

import deviceRoutes from './routes/devices';
import healthRoutes from './routes/health';
import docsRoutes from './routes/docs';
import backupRoutes from './routes/backup';

// Import consolidated proxy route

import proxyRoutes from './routes/proxy';


class APIGateway {
  app: Application;
  server: http.Server;
  port: number | string;
  wss!: WebSocket.Server;

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
    // Trust proxy for accurate IP detection (needed for rate limiting and logging)
    this.app.set('trust proxy', true);

    // Security middleware
    this.app.use(helmet());
    this.app.use(cors());

    // Rate limiting with better configuration for proxy environments
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: typeof process.env.API_RATE_LIMIT === 'string' ? parseInt(process.env.API_RATE_LIMIT) : 100,
      message: 'Muitas requisições deste IP, tente novamente em 15 minutos.',
      standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
      legacyHeaders: false, // Disable the `X-RateLimit-*` headers
      // Use a more reliable key generator that handles proxied requests
      keyGenerator: (req) => {
        return req.ip || req.connection.remoteAddress || 'unknown';
      }
    });
    this.app.use(limiter);

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Logging (reduce verbosity in production)
    this.app.use((req, res, next) => {
      // Only log non-health check requests in production to reduce log volume
      if (process.env.NODE_ENV === 'production' && req.path === '/api/health') {
        return next();
      }
      logger.info(`${req.method} ${req.path} - ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    // Public routes
    this.app.use('/api/health', healthRoutes);
    this.app.use('/docs', docsRoutes);

    // protected routes
    // Consolidated proxy routes with instance_id support
    this.app.use('/api', authMiddleware, proxyRoutes);

    this.app.use('/api/devices', authMiddleware, deviceRoutes);
    this.app.use('/api/backup', authMiddleware, backupRoutes);    

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        name: 'WhatsApp Multi-Platform API Gateway',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString(),
        endpoints: {
          health: '/api/health',
          devices: '/api/devices',
          backup: '/api/backup',
          proxy: '/api/* (app, send, user, message, chat, group, newsletter)',
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

    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      logger.info(`WebSocket client connected: ${req.socket.remoteAddress}`);

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Connected to WhatsApp Gateway WebSocket',
        timestamp: new Date().toISOString()
      }));

      // Handle messages from client
      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const message = JSON.parse(data.toString());
          logger.info(`WebSocket message received:`, message);
          // Handle different message types
          if (message.type === 'join-device') {
            (ws as any).deviceFilter = message.deviceHash;
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
        } catch (error: any) {
          logger.error('Error parsing WebSocket message:', error);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid JSON message',
            timestamp: new Date().toISOString()
          }));
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        logger.info(`WebSocket client disconnected: ${code} ${reason.toString()}`);
      });

      ws.on('error', (error: Error) => {
        logger.error('WebSocket error:', error);
      });
    });

    // Make WebSocket server available globally
    (global as any).webSocketServer = this.wss;
    
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

      // Initialize Backup Manager
      console.log('💾 Inicializando backupManager...');
      await backupManager.initialize();
      console.log('✅ backupManager inicializado');

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
  console.error('ERRO CRÍTICO:', (error as any).message);
  console.error('STACK:', (error as any).stack);
      process.exit(1);
    }
  }

  async shutdown() {
    logger.info('Iniciando shutdown graceful...');
    
    try {
      // Stop update manager
      updateManager.stop();
      
      // Stop backup manager
      backupManager.stop();
      
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

export default gateway;