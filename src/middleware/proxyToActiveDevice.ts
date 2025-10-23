import axios from 'axios';
import { asyncHandler, CustomError } from './errorHandler';
import deviceManager from '../services/newDeviceManager';
import DeviceRepository from '../repositories/DeviceRepository';
import logger from '../utils/logger';

const DEFAULT_ADMIN_USER = process.env.DEFAULT_ADMIN_USER || 'admin';
const DEFAULT_ADMIN_PASS = process.env.DEFAULT_ADMIN_PASS || 'admin';

/**
 * Simplified middleware that combines:
 * - resolveInstance (find device by deviceHash)
 * - ensureActive (validate device is active/connected)  
 * - proxyToContainer (proxy request to device container)
 * 
 * All in one step for better performance and simplicity
 */
import { Request, Response, NextFunction } from 'express';
const proxyToActiveDevice = asyncHandler(async (req: Request, res: Response, next?: NextFunction) => {
  // 1. Extract instanceId from header
  const instanceId = req.get('deviceHash');
  if (!instanceId) {
    throw new CustomError('Header deviceHash é obrigatório', 400, 'MISSING_INSTANCE_ID');
  }

  // 2. Resolve device (combines resolveInstance logic)
  let device = await deviceManager.getDevice(instanceId);
  
  if (!device) {
    const dbDevice = await DeviceRepository.findByDeviceHash(instanceId);
    if (dbDevice) {
      device = {
        id: dbDevice.id,
        deviceHash: dbDevice.device_hash,
        status: dbDevice.status,
        containerInfo: {
          containerId: dbDevice.container_id,
          port: dbDevice.container_port
        },
        webhookUrl: dbDevice.webhook_url,
        webhookSecret: dbDevice.webhook_secret,
        statusWebhookUrl: dbDevice.status_webhook_url,
        statusWebhookSecret: dbDevice.status_webhook_secret,
        createdAt: dbDevice.created_at,
        updatedAt: dbDevice.updated_at,
        lastSeen: dbDevice.last_seen
      };
    }
  }

  if (!device) {
    throw new CustomError(
      `Dispositivo com device hash ${instanceId} não encontrado`,
      404,
      'DEVICE_NOT_FOUND'
    );
  }

  // 3. Ensure device is active (combines ensureActive logic)
  if (device.status !== 'active' && device.status !== 'connected') {
    throw new CustomError(
      `Dispositivo ${instanceId} não está ativo. Status: ${device.status}`,
      400,
      'DEVICE_NOT_ACTIVE'
    );
  }

  // 4. Ensure container info exists
  if (!device.containerInfo?.port) {
    throw new CustomError(
      `Container não encontrado para dispositivo ${instanceId}`,
      500,
      'CONTAINER_NOT_FOUND'
    );
  }

  // 5. Proxy to container (combines proxyToContainer logic)
  const containerPort = device.containerInfo.port;
  const targetUrl = `http://localhost:${containerPort}${req.originalUrl.replace('/api', '')}`;

  // Only pass-through for specific routes that need additional processing
  const isLoginRoute = req.path === '/app/login';

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${DEFAULT_ADMIN_PASS}`).toString('base64')}`
  };

  // Attach device to request for next middleware
  (req as any).device = device;

  try {
    logger.debug(`Proxying ${req.method} ${req.originalUrl} to ${targetUrl} for device ${instanceId}`);
    
    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.body,
      params: req.query,
      headers: headers,
      timeout: 30000
    });

    // Store response data in request for next middleware or send directly
    (req as any).proxyResponse = {
      status: response.status,
      data: response.data
    };

    // Pass-through only for login route, otherwise respond directly
    if (isLoginRoute && next) {
      next();
    } else {
      res.status(response.status).json(response.data);
    }

  } catch (error) {
    const err = error as any;
    if (err.response) {
      // Container responded with error
      logger.warn(`Container error for device ${instanceId}: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
      
      // Store error response in request or send directly
      (req as any).proxyResponse = {
        status: err.response.status,
        data: err.response.data
      };

      if (isLoginRoute && next) {
        next();
      } else {
        res.status(err.response.status).json(err.response.data);
      }
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      // Container is not reachable
      throw new CustomError(
        `Dispositivo ${instanceId} não está acessível. Container pode estar desligado.`,
        503,
        'CONTAINER_UNREACHABLE'
      );
    } else {
      // Other network/proxy errors
      logger.error(`Proxy error for device ${instanceId}:`, err.message);
      throw new CustomError(
        'Erro interno no proxy da requisição',
        500,
        'PROXY_ERROR'
      );
    }
  }
});

export default proxyToActiveDevice;