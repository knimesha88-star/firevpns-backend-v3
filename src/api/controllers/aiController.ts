import { Request, Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import {
  getAiAssistantSettings,
  saveAiAssistantSettings,
  checkRateLimit,
  generateAiSupportReply,
  resolveLanguageMode,
  ChatHistoryTurn,
} from '../services/aiAssistantService.js';

export const getPublicAiConfigHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const settings = await getAiAssistantSettings();
    res.json({
      success: true,
      config: {
        assistantName: 'FIREVPNs Bot',
        enabled: settings.enabled,
        defaultLanguage: settings.defaultLanguage || 'auto',
        welcomeMessage: settings.welcomeMessage,
        welcomeMessageSi: settings.welcomeMessageSi,
        suggestedQuestions: settings.suggestedQuestions,
        suggestedQuestionsSi: settings.suggestedQuestionsSi,
        maxMessageLength: settings.maxMessageLength,
        maxMessagesPerSession: settings.maxMessagesPerSession,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Failed to load FIREVPNs Bot configuration.',
    });
  }
};

export const postAiChatHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const settings = await getAiAssistantSettings();
    if (!settings.enabled) {
      res.status(503).json({
        success: false,
        error:
          'FIREVPNs Bot is currently offline. Please reach our support team on WhatsApp or Telegram at 0769225099.',
      });
      return;
    }

    const rawMessage = req.body?.message;
    if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
      res.status(400).json({
        success: false,
        error: 'Please enter a valid message.',
      });
      return;
    }

    const trimmedMessage = rawMessage.trim();
    if (trimmedMessage.length > settings.maxMessageLength) {
      res.status(400).json({
        success: false,
        error: `Message is too long. Maximum allowed length is ${settings.maxMessageLength} characters.`,
      });
      return;
    }

    // Extract optional Bearer token for customer-specific verified context & rate-limit key
    const authHeader = req.headers.authorization || (req.headers as any)?.Authorization;
    const authToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.split(' ')[1]
        : undefined;

    const forwarded = req.headers['x-forwarded-for'];
    const clientIp =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
      req.socket?.remoteAddress ||
      'unknown-ip';
    // Always key rate limiting by client IP so rotating arbitrary fake Bearer tokens cannot bypass throttling
    const rateKey = `ip:${clientIp}`;

    const rateStatus = checkRateLimit(rateKey, settings.maxMessagesPerMinute);
    if (!rateStatus.allowed) {
      res.status(429).json({
        success: false,
        retryAfterSeconds: rateStatus.retryAfterSeconds,
        error: `You are sending messages too quickly. Please wait ${rateStatus.retryAfterSeconds} seconds and try again.`,
      });
      return;
    }

    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const sanitizedHistory: ChatHistoryTurn[] = rawHistory
      .filter(
        (item: any) =>
          item &&
          (item.role === 'user' || item.role === 'model') &&
          typeof item.text === 'string' &&
          item.text.trim().length > 0
      )
      .slice(-settings.maxHistoryMessages)
      .map((item: any) => ({
        role: item.role as 'user' | 'model',
        text: String(item.text).trim().slice(0, settings.maxMessageLength),
      }));

    const requestedLanguage = req.body?.language
      ? resolveLanguageMode(String(req.body.language))
      : undefined;

    const result = await generateAiSupportReply({
      message: trimmedMessage,
      history: sanitizedHistory,
      authToken,
      language: requestedLanguage,
    });

    res.json({
      success: true,
      reply: result.reply,
      assistantName: 'FIREVPNs Bot',
      detectedLanguage: result.detectedLanguage,
      fallbackUsed: Boolean(result.fallbackUsed),
    });
  } catch (error: any) {
    console.error('[AiController] Error in postAiChatHandler:', error?.message || error);
    res.status(500).json({
      success: false,
      error:
        'FIREVPNs Bot is temporarily unavailable. Please try again in a moment or contact human support on WhatsApp/Telegram at 0769225099.',
    });
  }
};

export const getAdminAiSettingsHandler = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settings = await getAiAssistantSettings();
    const apiKeyConfigured = Boolean(
      process.env.GEMINI_API_KEY &&
        process.env.GEMINI_API_KEY.trim() !== '' &&
        process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    );

    res.json({
      success: true,
      settings,
      environment: {
        apiKeyConfigured,
        envModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
        supportedModels: [
          { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (Recommended — Fast & Accurate)' },
          { id: 'gemini-flash-latest', label: 'Gemini Flash Latest (Auto-Updated Flash Alias)' },
          { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite (Ultra-Low Latency)' },
        ],
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error:
        process.env.NODE_ENV === 'production'
          ? 'Failed to load FIREVPNs Bot admin settings.'
          : error?.message || 'Failed to load FIREVPNs Bot admin settings.',
    });
  }
};

export const saveAdminAiSettingsHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = req.body || {};
    const updated = await saveAiAssistantSettings({
      enabled: body.enabled,
      model: body.model,
      defaultLanguage: body.defaultLanguage,
      welcomeMessage: body.welcomeMessage,
      welcomeMessageSi: body.welcomeMessageSi,
      systemInstructions: body.systemInstructions,
      suggestedQuestions: body.suggestedQuestions,
      suggestedQuestionsSi: body.suggestedQuestionsSi,
      maxMessagesPerMinute: body.maxMessagesPerMinute,
      maxMessagesPerSession: body.maxMessagesPerSession,
      maxMessageLength: body.maxMessageLength,
      maxHistoryMessages: body.maxHistoryMessages,
    });

    res.json({
      success: true,
      message: 'FIREVPNs Bot settings saved successfully.',
      settings: updated,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error:
        process.env.NODE_ENV === 'production'
          ? 'Failed to save FIREVPNs Bot settings.'
          : error?.message || 'Failed to save FIREVPNs Bot settings.',
    });
  }
};
