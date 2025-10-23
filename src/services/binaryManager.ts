
import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import WebSocket from 'ws';
import logger from '../utils/logger';
import { BIN_PATH, SESSIONS_DIR } from '../utils/paths';
import deviceManager from './newDeviceManager';
import statusWebhookManager from './statusWebhookManager';

class BinaryManager {
  binaryPath: string;
  processes: Map<string, any>;
  websocketConnections: Map<string, any>;
  basicAuthUsername: string;
  basicAuthPassword: string;
  isShuttingDown: boolean = false;

  constructor() {
    this.binaryPath = BIN_PATH;
    this.processes = new Map(); // deviceHash -> process info
    this.websocketConnections = new Map(); // deviceHash -> websocket connection
    this.basicAuthUsername = process.env.DEFAULT_ADMIN_USER || 'admin';
    this.basicAuthPassword = process.env.DEFAULT_ADMIN_PASS || 'admin';
    
    // Registrar handlers para desligamento do sistema
    process.on('SIGINT', this.prepareForShutdown.bind(this));
    process.on('SIGTERM', this.prepareForShutdown.bind(this));
  }
  
  /**
   * Prepara o sistema para desligamento, evitando que sessões ativas sejam marcadas como stopped
   */
  prepareForShutdown() {
    logger.info('Sistema em processo de desligamento, mantendo status das sessões ativas');
    this.isShuttingDown = true;
  }

  async initialize() {
    logger.info('Inicializando Binary Manager...');
    try {
      // Check if binary exists and is executable
      await this.checkBinaryExists();
      logger.info('Iniciando loadExistingProcesses...');
      // Load existing processes from device manager
      await this.loadExistingProcesses();
      logger.info('loadExistingProcesses concluído');
      // Start health check monitoring
      this.startHealthCheckMonitoring();
      logger.info('Binary Manager inicializado com sucesso');
    } catch (error) {
      logger.error('Erro ao inicializar Binary Manager:', error);
      throw error;
    }
  }

  /**
   * Check if the WhatsApp binary exists and is executable
   */
  async checkBinaryExists() {
    try {
      await fs.access(this.binaryPath, fs.constants.F_OK | fs.constants.X_OK);
      logger.info(`Binary WhatsApp encontrado em: ${this.binaryPath}`);
    } catch (error) {
      throw new Error(`Binary WhatsApp não encontrado ou não executável em: ${this.binaryPath}`);
    }
  }

  /**
   * Load existing processes and sync with device manager
   */
  async loadExistingProcesses() {
    try {
      const devices = await deviceManager.getAllDevices();
      logger.info(`Verificando ${devices.length} dispositivos registrados`);
      for (const device of devices) {
  logger.info(`Dispositivo ${device.deviceHash}: processId=${(device as any).processId}, status=${device.status}`);
        // Check if device had an active session before restart
  if ((device as any).processId) {
          logger.info(`Verificando se processo ${(device as any).processId} ainda está rodando...`);
          // Check if process is still running (unlikely after container restart)
          const isRunning = await this.isProcessRunning((device as any).processId);
          if (isRunning) {
            this.processes.set(device.deviceHash, {
              pid: (device as any).processId,
              deviceHash: device.deviceHash,
              port: (device as any).port,
              status: 'running',
              startedAt: new Date(device.updatedAt)
            });
            logger.info(`Processo para ${device.deviceHash} ainda está rodando (PID: ${(device as any).processId})`);
          } else {
            logger.info(`Processo ${(device as any).processId} não está mais rodando, tentando reiniciar...`);
            // Process is dead - try to restart if session files exist
            await this.restartSessionIfExists(device);
          }
        } else if (device.status === 'active' || device.status === 'connected') {
          logger.info(`Dispositivo ${device.deviceHash} marcado como ${device.status} sem processo, tentando reiniciar...`);
          // Device is marked as active/connected but has no process - try to restart
          await this.restartSessionIfExists(device);
        } else if (device.status === 'error' || device.status === 'stopped') {
          logger.info(`Dispositivo ${device.deviceHash} com status ${device.status}, verificando se há sessão existente...`);
          // Device has error/stopped status - check if session exists and restart
          await this.restartSessionIfExists(device);
        } else {
          logger.info(`Dispositivo ${device.deviceHash} não precisa de restart (status: ${device.status})`);
        }
      }
    } catch (error) {
      logger.error('Erro ao carregar processos existentes:', error);
    }
  }

  /**
   * Restart session if session files exist
   * @param {Object} device - Device info
   */
  async restartSessionIfExists(device: any) {
    try {
      const sessionPath = path.join(SESSIONS_DIR, device.deviceHash);
      const sessionDbPath = path.join(sessionPath, 'whatsapp.db');
      
      // Determinar se estamos usando banco de dados externo
      const usingExternalDB = !!process.env.DB_URI;
      
      // DB externo: sempre reinicia o processo
      if (usingExternalDB) {
        logger.info(`Usando banco de dados externo para ${device.deviceHash}, reiniciando processo...`);
        await this.startProcess(device.deviceHash);
        logger.info(`Processo reiniciado automaticamente para ${device.deviceHash} (DB externo)`);
        return;
      }
      
      // DB local: se estava ativo/conectado, iniciar processo mesmo sem sessão local
      if (device.status === 'active' || device.status === 'connected') {
        logger.info(`Dispositivo ${device.deviceHash} estava '${device.status}', iniciando processo mesmo sem sessão local`);
        await this.startProcess(device.deviceHash);
        return;
      }
      
      // Para stopped/error: iniciar apenas se sessão local existir
      try {
        await fs.access(sessionDbPath);
        logger.info(`Sessão local detectada para ${device.deviceHash}, reiniciando...`);
        await this.startProcess(device.deviceHash);
      } catch {
        logger.info(`Sessão local não encontrada para ${device.deviceHash}; mantendo status '${device.status || 'stopped'}'`);
        // não alterar status aqui; manter o existente
      }
    } catch (error) {
      logger.error(`Erro ao tentar reiniciar sessão para ${device.deviceHash}:`, error);
      await deviceManager.updateDevice(device.deviceHash, {
        processId: null,
        status: 'error'
      });
    }
  }

  /**
   * Check if a process is still running
   * @param {number} pid - Process ID
   * @returns {Promise<boolean>} - True if process is running
   */
  async isProcessRunning(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Create and start a new WhatsApp process for a device
   * @param {string} deviceHash - Device hash
   * @param {Object} options - Process options
   * @returns {Promise<Object>} - Process information
   */
  async startProcess(deviceHash: string, options: any = {}) {
    // Check if process already exists
    if (this.processes.has(deviceHash)) {
      // Verificar se o processo ainda está realmente em execução
      const processInfo = this.processes.get(deviceHash);
      const isRunning = processInfo.pid ? await this.isProcessRunning(processInfo.pid) : false;

      if (isRunning) {
        logger.warn(`Processo para ${deviceHash} já existe e está em execução (PID: ${processInfo.pid})`);
        
        // Retornar informações do processo existente em vez de lançar erro
        return {
          pid: processInfo.pid,
          deviceHash,
          port: processInfo.port,
          status: 'running',
          alreadyRunning: true
        };
      } else {
        // Processo está registrado mas não está em execução, remover da lista
        logger.info(`Processo para ${deviceHash} estava registrado mas não está em execução, removendo referência`);
        this.processes.delete(deviceHash);
      }
    }

    // Get device information
    const device = await deviceManager.getDevice(deviceHash);
    if (!device) {
      throw new Error(`Dispositivo ${deviceHash} não está registrado`);
    }

  const devicePort = (device as any).port || (device as any).containerInfo?.port;
    if (!devicePort) {
      throw new Error(`Porta não definida para dispositivo ${deviceHash}`);
    }

    logger.info(`Iniciando processo WhatsApp para ${deviceHash} na porta ${devicePort}`);

    try {
      // Determinar se estamos usando banco de dados externo
      const usingExternalDB = !!process.env.DB_URI;
      
      // Inicializar sessionPath para todos os casos
      const sessionPath = path.join(SESSIONS_DIR, deviceHash);

      // Se não estiver usando banco externo, garantir que o diretório de sessão exista
      if(!usingExternalDB) await this.ensureSessionDirectory(sessionPath);

      // Prepare environment variables
      const env = {
        ...process.env,
        APP_PORT: devicePort.toString(),
        APP_BASIC_AUTH: `${this.basicAuthUsername}:${this.basicAuthPassword}`,
        APP_DEBUG: 'true',
        APP_OS: 'Chrome',
        APP_ACCOUNT_VALIDATION: 'false',
        DB_URI: process.env.DB_URI || `file:${sessionPath}/whatsapp.db?_foreign_keys=on`,
        WHATSAPP_WEBHOOK: device.webhookUrl || '',
        WHATSAPP_WEBHOOK_SECRET: device.webhookSecret || '',
        ...this.getEnvironmentVariables(options)
      };

      // Spawn the WhatsApp binary process
      const childProcess = spawn(this.binaryPath, ['rest'], {
        env,
        cwd: usingExternalDB ? process.cwd() : sessionPath,
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Handle process events
      childProcess.stdout.on('data', (data) => {
        logger.info(`WhatsApp ${deviceHash}: ${data.toString().trim()}`);
      });

      childProcess.stderr.on('data', (data) => {
        logger.error(`WhatsApp ${deviceHash} ERROR: ${data.toString().trim()}`);
      });

      childProcess.on('close', async (code) => {
        logger.info(`Processo WhatsApp ${deviceHash} finalizado com código ${code}`);
        this.processes.delete(deviceHash);
        
        // Não alterar o status se o sistema estiver sendo encerrado
        // Isso evita que sessões ativas sejam marcadas como stopped durante reinicialização
        if (!this.isShuttingDown) {
          await deviceManager.updateDevice(deviceHash, { 
            processId: null,
            status: code === 0 ? 'stopped' : 'error' 
          });
        } else {
          logger.info(`Sistema em desligamento, mantendo status atual para ${deviceHash}`);
        }
      });

      childProcess.on('error', async (error) => {
        logger.error(`Erro no processo WhatsApp ${deviceHash}:`, error);
        this.processes.delete(deviceHash);
        await deviceManager.updateDevice(deviceHash, { 
          processId: null,
          status: 'error' 
        });
      });

      // Store process reference
      const processInfo = {
        pid: childProcess.pid,
        process: childProcess,
        deviceHash,
        port: devicePort,
        status: 'running',
        startedAt: new Date(),
        sessionPath
      };

      this.processes.set(deviceHash, processInfo);

      // Update device manager
      await deviceManager.updateDevice(deviceHash, {
        processId: childProcess.pid,
        status: 'active'
      });

      logger.info(`Processo WhatsApp iniciado para ${deviceHash} (PID: ${childProcess.pid})`);
      
      // Connect to container WebSocket
      setTimeout(() => {
        this.connectToContainerWebSocketWithRetry(deviceHash, devicePort);
      }, 5000);
      
      return {
        pid: childProcess.pid,
        deviceHash,
        port: devicePort,
        status: 'running'
      };

    } catch (error) {
      logger.error(`Erro ao iniciar processo para ${deviceHash}:`, error);
      throw error;
    }
  }

  /**
   * Stop a WhatsApp process
   * @param {string} deviceHash - Device hash
   * @param {number} timeout - Stop timeout in seconds
   * @returns {Promise<boolean>} - Success status
   */
  async stopProcess(deviceHash: string, timeout: number = 30) {
    const processInfo = this.processes.get(deviceHash);
    if (!processInfo) {
      throw new Error(`Processo para ${deviceHash} não encontrado`);
    }

    try {
      logger.info(`Parando processo WhatsApp para ${deviceHash} (PID: ${processInfo.pid})`);
      
      // Send SIGTERM signal
      processInfo.process.kill('SIGTERM');
      
      // Wait for graceful shutdown with timeout
      const killed = await this.waitForProcessExit(processInfo.pid, timeout * 1000);
      
      if (!killed) {
        logger.warn(`Processo ${deviceHash} não parou graciosamente, forçando término`);
        processInfo.process.kill('SIGKILL');
        await this.waitForProcessExit(processInfo.pid, 5000);
      }

      // Clean up references
      this.processes.delete(deviceHash);
      this.disconnectContainerWebSocket(deviceHash);
      await deviceManager.updateDevice(deviceHash, { 
        processId: null,
        status: 'stopped' 
      });

      logger.info(`Processo WhatsApp para ${deviceHash} parado com sucesso`);
      return true;
    } catch (error) {
      logger.error(`Erro ao parar processo para ${deviceHash}:`, error);
      throw error;
    }
  }

  /**
   * Wait for process to exit
   * @param {number} pid - Process ID
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<boolean>} - True if process exited, false if timeout
   */
  async waitForProcessExit(pid: number, timeout: number) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (!this.isProcessRunning(pid)) {
          clearInterval(checkInterval);
          resolve(true);
        } else if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          resolve(false);
        }
      }, 100);
    });
  }

  /**
   * Restart a WhatsApp process
   * @param {string} deviceHash - Device hash
   * @returns {Promise<boolean>} - Success status
   */
  async restartProcess(deviceHash: string) {
    try {
      await this.stopProcess(deviceHash);
      await this.startProcess(deviceHash);
      return true;
    } catch (error) {
      logger.error(`Erro ao reiniciar processo para ${deviceHash}:`, error);
      throw error;
    }
  }

  /**
   * Get process status
   * @param {string} deviceHash - Device hash
   * @returns {Promise<Object|null>} - Process status
   */
  async getProcessStatus(deviceHash: string) {
    const processInfo = this.processes.get(deviceHash);
    if (!processInfo) {
      return null;
    }

    try {
      const isRunning = await this.isProcessRunning(processInfo.pid);
      return {
        pid: processInfo.pid,
        status: isRunning ? 'running' : 'stopped',
        running: isRunning,
        startedAt: processInfo.startedAt,
        port: processInfo.port,
        deviceHash,
        sessionPath: processInfo.sessionPath
      };
    } catch (error) {
      logger.error(`Erro ao obter status do processo ${deviceHash}:`, error);
      return null;
    }
  }

  /**
   * List all managed processes
   * @returns {Promise<Array>} - List of processes
   */
  async listProcesses() {
    const processes = [];
    
    for (const [deviceHash, processInfo] of this.processes) {
      try {
        const status = await this.getProcessStatus(deviceHash);
        if (status) {
          processes.push(status);
        }
      } catch (error) {
        logger.error(`Erro ao obter status do processo ${deviceHash}:`, error);
      }
    }

    return processes;
  }

  /**
   * Start health check monitoring
   */
  startHealthCheckMonitoring() {
  const interval = process.env.HEALTH_CHECK_INTERVAL ? parseInt(process.env.HEALTH_CHECK_INTERVAL) : 30000;
    
    setInterval(async () => {
      await this.performHealthChecks();
    }, interval);

    logger.info(`Monitoramento de health check iniciado (${interval}ms)`);
  }

  /**
   * Perform health checks on all processes
   */
  async performHealthChecks() {
    for (const [deviceHash, processInfo] of this.processes) {
      try {
        const isRunning = await this.isProcessRunning(processInfo.pid);
        
        if (!isRunning && processInfo.status === 'running') {
          logger.warn(`Processo ${deviceHash} parou inesperadamente`);
          this.processes.delete(deviceHash);
          await deviceManager.updateDevice(deviceHash, { 
            processId: null,
            status: 'error' 
          });
          
          // Emit event for monitoring
          if ((global as any).webSocketServer) {
            const message = JSON.stringify({
              type: 'process-stopped',
              deviceHash,
              timestamp: new Date().toISOString()
            });
            
            (global as any).webSocketServer.clients.forEach((client: any) => {
              if (client.readyState === WebSocket.OPEN) {
                if (!client.deviceFilter || client.deviceFilter === deviceHash) {
                  client.send(message);
                }
              }
            });
          }
        }
      } catch (error) {
        logger.error(`Erro no health check do processo ${deviceHash}:`, error);
      }
    }
  }

  /**
   * Ensure session directory exists
   * @param {string} sessionPath - Session directory path
   */
  async ensureSessionDirectory(sessionPath: string) {
    try {
      await fs.mkdir(sessionPath, { recursive: true });
      await fs.chmod(sessionPath, 0o755);
    } catch (error) {
      logger.error(`Erro ao criar diretório de sessão ${sessionPath}:`, error);
      throw error;
    }
  }

  /**
   * Get environment variables for process
   * @param {Object} options - Process options
   * @returns {Object} - Environment variables
   */
  getEnvironmentVariables(options: any) {
    const defaultEnv = {
      NODE_ENV: process.env.NODE_ENV || 'production',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info'
    };

    if (options.environment) {
      return { ...defaultEnv, ...options.environment };
    }

    return defaultEnv;
  }

  /**
   * Connect to container WebSocket
   * @param {string} deviceHash - Device hash
   * @param {number} port - Container port
   */
  connectToContainerWebSocketWithRetry(deviceHash: string, port: number) {
    const wsUrl = `ws://localhost:${port}/ws`;
    
    try {
      logger.info(`Conectando ao WebSocket ${deviceHash} em ${wsUrl}`);
      
      const ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${this.basicAuthUsername}:${this.basicAuthPassword}`).toString('base64')}`
        }
      });
      
      ws.on('open', () => {
        logger.info(`WebSocket conectado: ${deviceHash}`);
        this.websocketConnections.set(deviceHash, ws);
        this.setupWebSocketEvents(ws, deviceHash, port);
      });
      
      ws.on('error', (error) => {
        logger.warn(`WebSocket error ${deviceHash}: ${error.message}`);
        this.websocketConnections.delete(deviceHash);
      });
      
    } catch (error) {
      logger.error(`Erro ao conectar WebSocket ${deviceHash}:`, error);
    }
  }

  setupWebSocketEvents(ws: WebSocket, deviceHash: string, port: number) {
    // Notify WebSocket clients
  if ((global as any).webSocketServer) {
      const connectMessage = JSON.stringify({
        type: 'container-websocket-connected',
        deviceHash,
        port,
        timestamp: new Date().toISOString()
      });
      
  ((global as any).webSocketServer.clients as any[]).forEach((client: any) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(connectMessage);
        }
      });
    }
    
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Mirror to WebSocket clients
  if ((global as any).webSocketServer) {
          const wsMessage = JSON.stringify({
            type: 'whatsapp-websocket-message',
            deviceHash,
            port,
            message,
            timestamp: new Date().toISOString()
          });
          
          ((global as any).webSocketServer.clients as any[]).forEach((client: any) => {
            if (client.readyState === WebSocket.OPEN) {
              // Send to all clients, or filter by device if they joined a specific device
              if (!client.deviceFilter || client.deviceFilter === deviceHash) {
                client.send(wsMessage);
              }
            }
          });
        }
        
        // Send to status webhook if configured (non-blocking)
        statusWebhookManager.handleContainerEvent(deviceHash, message).catch(error => {
          logger.error(`Webhook error for ${deviceHash}:`, error.message);
        });
        
        logger.debug(`WebSocket message from ${deviceHash}:`, message);
      } catch (error) {
        logger.error(`Erro ao processar mensagem WebSocket de ${deviceHash}:`, error);
      }
    });
    
    ws.on('error', (error) => {
      logger.warn(`WebSocket error ${deviceHash}: ${error.message}`);
      this.websocketConnections.delete(deviceHash);
    });
    
    ws.on('close', (code, reason) => {
      logger.info(`WebSocket ${deviceHash} fechado (${code}: ${reason})`);
      this.websocketConnections.delete(deviceHash);
      
  if ((global as any).webSocketServer) {
        const closeMessage = JSON.stringify({
          type: 'container-websocket-closed',
          deviceHash,
          port,
          code,
          reason: reason?.toString(),
          timestamp: new Date().toISOString()
        });
        
  ((global as any).webSocketServer.clients as any[]).forEach((client: any) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(closeMessage);
          }
        });
      }
    });
  }


  /**
   * Disconnect container WebSocket
   * @param {string} deviceHash - Device hash
   */
  disconnectContainerWebSocket(deviceHash: any) {
    const ws = this.websocketConnections.get(deviceHash);
    if (ws) {
      logger.info(`Desconectando WebSocket do container ${deviceHash}`);
      ws.close();
      this.websocketConnections.delete(deviceHash);
    }
  }

  /**
   * Cleanup all processes
   */
  async cleanup() {
    logger.info('Iniciando cleanup dos processos WhatsApp...');
    
    // Close all WebSocket connections
    for (const [deviceHash] of this.websocketConnections) {
      this.disconnectContainerWebSocket(deviceHash);
    }
    
    const cleanupPromises = Array.from(this.processes.keys()).map(async (deviceHash) => {
      try {
        await this.stopProcess(deviceHash);
        logger.info(`Processo ${deviceHash} parado durante cleanup`);
      } catch (error) {
        logger.error(`Erro ao parar processo ${deviceHash} durante cleanup:`, error);
      }
    });

    await Promise.allSettled(cleanupPromises);
    logger.info('Cleanup dos processos WhatsApp concluído');
  }

}

const binaryManager = new BinaryManager();
export default binaryManager;