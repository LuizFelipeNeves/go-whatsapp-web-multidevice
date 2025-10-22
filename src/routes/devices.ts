import resolveInstance from '../middleware/resolveInstance';

import express, { Request, Response } from 'express';
import { asyncHandler, CustomError } from '../middleware/errorHandler';
import deviceManager from '../services/newDeviceManager';
import binaryManager from '../services/binaryManager';
import DeviceRepository from '../repositories/DeviceRepository';
import logger from '../utils/logger';
import DeviceUtils from '../utils/deviceUtils';

const router = express.Router();

/**
 * GET /api/devices
 * List all devices
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { status, limit, offset } = req.query;

  let devices;
  const statusStr = status as string[];
  if (statusStr) {
    devices = await deviceManager.getDevicesByStatus(statusStr);
  } else {
    devices = await deviceManager.getAllDevices();
  }

  // Convert to array and apply pagination
  const devicesArray = Object.values(devices);
  const total = devicesArray.length;

  let paginatedDevices = devicesArray;
  const limitStr = typeof limit === 'string' ? limit : Array.isArray(limit) ? limit[0] : undefined;
  const offsetStr = typeof offset === 'string' ? offset : Array.isArray(offset) ? offset[0] : undefined;
  if (limitStr) {
    const limitNum = parseInt(limitStr as string);
    const offsetNum = offsetStr ? parseInt(offsetStr as string) : 0;
    paginatedDevices = devicesArray.slice(offsetNum, offsetNum + limitNum);
  }

  // Add container/process status e enriquecer dados de saída
  const devicesWithStatus = await Promise.all(
    paginatedDevices.map(async (device: any) => {
      const process = await binaryManager.getProcessStatus(device.deviceHash);
      const containerPort = device.port || device.containerInfo?.port || process?.port || null;
      const containerId = device.containerInfo?.containerId || null;
      const messagesWebhookUrl = device.webhookUrl || null;
      const statusWebhookUrl = device.statusWebhookUrl || null;
      const webhookConfigured = Boolean(messagesWebhookUrl);
      const statusWebhookConfigured = Boolean(statusWebhookUrl);

      return {
        id: device.id,
        deviceHash: device.deviceHash,
        status: device.status,
        container: {
          id: containerId,
          port: containerPort
        },
        process: process || null,
        webhooks: {
          messages: webhookConfigured,
          status: statusWebhookConfigured,
          messagesUrl: messagesWebhookUrl,
          statusUrl: statusWebhookUrl,
          hasMessagesSecret: Boolean(device.webhookSecret),
          hasStatusSecret: Boolean(device.statusWebhookSecret)
        },
        createdAt: device.createdAt || null,
        updatedAt: device.updatedAt || null,
        lastSeen: device.lastSeen || null,
        endpoints: containerPort ? {
          restBase: `http://localhost:${containerPort}`,
          health: `http://localhost:${containerPort}/health`,
          ws: `ws://localhost:${containerPort}/ws`
        } : null
      };
    })
  );

  res.json({
    success: true,
    data: {
      devices: devicesWithStatus,
      pagination: {
        total,
        limit: limitStr ? parseInt(limitStr as string) : total,
        offset: offsetStr ? parseInt(offsetStr as string) : 0,
        hasMore: limitStr ? (offsetStr ? parseInt(offsetStr as string) : 0) + parseInt(limitStr as string) < total : false
      }
    }
  });
}));

/**
 * POST /api/devices
 * Register a new device (generates deviceHash automatically)
 */
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { autoStart = true, webhookUrl, webhookSecret, statusWebhookUrl, statusWebhookSecret } = req.body;

  // Generate unique device hash
  const deviceHash = DeviceUtils.generateDeviceHash();
  
  logger.info(`Iniciando registro para novo dispositivo: ${deviceHash}`);

  try {
    // Create device in DB
    await deviceManager.registerDevice(deviceHash, { 
      webhookUrl, 
      webhookSecret,
      statusWebhookUrl,
      statusWebhookSecret
    });

    logger.info(`Dispositivo ${deviceHash} criado no DB.`);

    // Start process if requested
    let process = null;
    if (autoStart) {
      logger.info(`Iniciando processo para ${deviceHash}...`);
      try {
        process = await binaryManager.startProcess(deviceHash);
      } catch (processError) {
        logger.warn(`Erro ao iniciar processo para ${deviceHash}, mas dispositivo foi criado:`, (processError as any)?.message);
      }
    }
    
    // Get final state
    const finalDeviceState = await deviceManager.getDevice(deviceHash);
    const finalProcessState = process || await binaryManager.getProcessStatus(deviceHash);

    logger.info(`Registro para ${deviceHash} concluído com sucesso.`);

    res.status(201).json({
      success: true,
      message: 'Dispositivo registrado com sucesso.',
      data: {
        deviceHash: finalDeviceState?.deviceHash ?? deviceHash,
        status: finalDeviceState?.status ?? 'unknown',
        processInfo: finalProcessState
      }
    });

  } catch (error) {
    logger.error(`Erro catastrófico ao registrar dispositivo ${deviceHash}:`, error);
    throw new CustomError('Ocorreu um erro inesperado durante o registro.', 500, 'REGISTRATION_UNEXPECTED_ERROR');
  }
}));

/**
 * PUT /api/devices
 * Update device information by instance ID
 */
router.put('/', resolveInstance, asyncHandler(async (req: Request, res: Response) => {
  const device = (req as any).device;
  const updates = req.body;

  // Filter allowed updates (não permitir alteração de hashes, etc.)
  const allowedFields = ['webhookUrl', 'webhookSecret', 'statusWebhookUrl', 'statusWebhookSecret'];
  const filteredUpdates: { [key: string]: any } = {};
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      filteredUpdates[key] = value;
    }
  }

  const updatedDevice = await DeviceRepository.update(device.id, filteredUpdates);

  logger.info(`Dispositivo ${device.deviceHash} atualizado`);

  res.json({
    success: true,
    message: 'Dispositivo atualizado com sucesso',
    data: {
      deviceHash: updatedDevice.device_hash,
      status: updatedDevice.status
    }
  });
}));

/**
 * DELETE /api/devices
 * Remove device by instance ID
 */
router.delete('/', resolveInstance, asyncHandler(async (req: Request, res: Response) => {
  const device = (req as any).device;
  const { force = false } = req.query;

  logger.info(`Removendo dispositivo: ${device.deviceHash}`);

  try {
    // Stop process first
    try {
      await binaryManager.stopProcess(device.deviceHash);
    } catch (error) {
      if (!force) throw error;
      logger.warn(`Erro ao parar processo, mas continuando devido ao force=true: ${(error as any)?.message}`);
    }

    // Remove from device manager
    const removed = await deviceManager.removeDevice(device.deviceHash);

    if (!removed) {
      throw new CustomError(
        'Erro ao remover dispositivo',
        500,
        'REMOVAL_ERROR'
      );
    }

    logger.info(`Dispositivo ${device.deviceHash} removido com sucesso`);

    res.json({
      success: true,
      message: 'Dispositivo removido com sucesso'
    });

  } catch (error) {
    logger.error(`Erro ao remover dispositivo ${device.deviceHash}:`, error);
    throw error;
  }
}));



/**
 * GET /api/devices/info
 * Get specific device information by instance ID
 */
router.get('/info', resolveInstance, asyncHandler(async (req: Request, res: Response) => {
  const device = (req as any).device;
  const process = await binaryManager.getProcessStatus(device.deviceHash);
  const containerPort = device.containerInfo?.port || process?.port || null;
  const containerId = device.containerInfo?.containerId || null;
  const messagesWebhookUrl = device.webhookUrl || null;
  const statusWebhookUrl = device.statusWebhookUrl || null;

  res.json({
    success: true,
    data: {
      id: device.id,
      deviceHash: device.deviceHash,
      status: device.status,
      container: { id: containerId, port: containerPort },
      process: process || null,
      webhooks: {
        messages: Boolean(messagesWebhookUrl),
        status: Boolean(statusWebhookUrl),
        messagesUrl: messagesWebhookUrl,
        statusUrl: statusWebhookUrl,
        hasMessagesSecret: Boolean(device.webhookSecret),
        hasStatusSecret: Boolean(device.statusWebhookSecret)
      },
      createdAt: device.createdAt || null,
      updatedAt: device.updatedAt || null,
      lastSeen: device.lastSeen || null,
      endpoints: containerPort ? {
        restBase: `http://localhost:${containerPort}`,
        health: `http://localhost:${containerPort}/health`,
        ws: `ws://localhost:${containerPort}/ws`
      } : null
    }
  });
}));

/**
 * POST /api/devices/start
 * Start device container by instance ID
 */
router.post('/start', resolveInstance, asyncHandler(async (req: Request, res: Response) => {
  const device = (req as any).device;

  logger.info(`Iniciando container para ${device.deviceHash}`);

  await binaryManager.startProcess(device.deviceHash);

  res.json({
    success: true,
    message: 'Processo iniciado com sucesso'
  });
}));

/**
 * POST /api/devices/stop
 * Stop device container by instance ID
 */
router.post('/stop', resolveInstance, asyncHandler(async (req: Request, res: Response) => {
  const device = (req as any).device;

  logger.info(`Parando container para ${device.deviceHash}`);

  await binaryManager.stopProcess(device.deviceHash);

  res.json({
    success: true,
    message: 'Processo parado com sucesso'
  });
}));

/**
 * POST /api/devices/restart
 * Restart device container by instance ID
 */
router.post('/restart', resolveInstance, asyncHandler(async (req: Request, res: Response) => {
  const device = (req as any).device;

  logger.info(`Reiniciando container para ${device.deviceHash}`);

  await binaryManager.restartProcess(device.deviceHash);

  res.json({
    success: true,
    message: 'Processo reiniciado com sucesso'
  });
}));

export default router;