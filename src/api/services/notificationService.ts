
import { supabaseAdmin } from '../../lib/supabase.js';
import { sendExpiryReminderEmail, sendVpnExpiredEmail } from './emailService.js';

export interface CreateNotificationParams {
  userId?: string | null;
  userEmail: string;
  title: string;
  message: string;
  type?: string;
  orderId?: string | null;
  vpnName?: string | null;
  vpnUuid?: string | null;
}

export const createCustomerNotification = async (
  params: CreateNotificationParams
): Promise<any> => {
  const {
    userId,
    userEmail,
    title,
    message,
    type = 'info',
    orderId,
    vpnName,
    vpnUuid
  } = params;

  console.log('[NotificationService] Creating notification:', {
    userId,
    userEmail,
    title,
    type,
    orderId,
    vpnName,
    vpnUuid
  });

  let resolvedUserId =
    userId &&
    !['N/A', 'null', 'undefined', ''].includes(String(userId).trim())
      ? String(userId).trim()
      : null;

  if (!resolvedUserId && userEmail) {
    try {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('email', userEmail)
        .maybeSingle();

      if (profile?.id) {
        resolvedUserId = profile.id;
      } else {
        const { data: orderUser } = await supabaseAdmin
          .from('orders')
          .select('customer_id')
          .eq('email', userEmail)
          .not('customer_id', 'is', null)
          .neq('customer_id', 'N/A')
          .limit(1)
          .maybeSingle();

        if (orderUser?.customer_id) {
          resolvedUserId = orderUser.customer_id;
        }
      }
    } catch (error: any) {
      console.warn(
        '[NotificationService] User ID resolution error:',
        error.message || error
      );
    }
  }

  let finalMessage = message;

  if (vpnName && !message.includes(vpnName)) {
    finalMessage = `${message} (VPN: ${vpnName})`;
  }

  // Existing public.notifications schema:
  // id, user_id, title, message, type, is_read, created_at
  const payload = {
    user_id: resolvedUserId,
    title,
    message: finalMessage,
    type,
    is_read: false,
    created_at: new Date().toISOString()
  };

  try {
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .insert(payload)
      .select()
      .maybeSingle();

    if (error) {
      console.error(
        '[NotificationService] Insert error:',
        error.message || error
      );
      throw error;
    }

    console.log('[NotificationService] Notification created:', data);
    return data;
  } catch (error: any) {
    console.error(
      '[NotificationService] Notification creation failed:',
      error.message || error
    );
    throw error;
  }
};

export const checkAndCreateExpiryNotifications = async (
  userId?: string,
  userEmail?: string
): Promise<void> => {
  if (!userId && !userEmail) return;

  console.log(
    `[NotificationService] Checking expiry notifications for: ${userId}`
  );

  try {
    let query = supabaseAdmin
      .from('vpn_configs')
      .select('*');

    if (userId) {
      query = query.eq('customer_uid', userId);
    } else {
      return;
    }

    const { data: configs, error: configErr } = await query;

    if (configErr) {
      console.warn(
        '[NotificationService] VPN config query error:',
        configErr.message
      );
      return;
    }

    if (!configs || configs.length === 0) return;

    const targetUserId = userId;

    if (!targetUserId) return;

    // Check ALL existing notifications, including read ones.
    // This prevents old expiry reminders from being recreated.
    const { data: existingNotifs, error: notifErr } = await supabaseAdmin
      .from('notifications')
      .select('id, user_id, title, message, type, is_read, created_at')
      .eq('user_id', targetUserId);

    if (notifErr) {
      console.warn(
        '[NotificationService] Existing notification query error:',
        notifErr.message
      );
      return;
    }

    const existingNotifList = existingNotifs || [];
    const now = Date.now();

    // Check if user has previously deleted notifications so we do not recreate deleted expiry alerts
    let userDeletedAt = 0;
    try {
      const { data: delDoc } = await supabaseAdmin
        .from('settings')
        .select('data')
        .eq('id', 'deleted_notifications_state')
        .maybeSingle();
      const map = delDoc?.data?.users || {};
      if (targetUserId && map[targetUserId]?.deletedAt) {
        userDeletedAt = Number(map[targetUserId].deletedAt) || 0;
      }
    } catch {}

    for (const cfg of configs) {
      const expVal =
        cfg.expiry_date ||
        cfg.expiry_time ||
        cfg.expiryDate ||
        cfg.expiryTime;

      if (!expVal) continue;

      let expMs: number | null = null;

      if (typeof expVal === 'number') {
        expMs = expVal < 10000000000 ? expVal * 1000 : expVal;
      } else {
        expMs = new Date(expVal).getTime();
      }

      if (!expMs || isNaN(expMs)) continue;

      // Do not recreate expiry notifications for configs that were already expired/expiring before the user deleted all notifications
      const cfgUpdatedMs = cfg.updated_at ? new Date(cfg.updated_at).getTime() : (cfg.created_at ? new Date(cfg.created_at).getTime() : 0);
      if (userDeletedAt > 0 && (!cfgUpdatedMs || cfgUpdatedMs <= userDeletedAt)) {
        continue;
      }

      const diffMs = expMs - now;
      const daysLeft = Math.ceil(
        diffMs / (1000 * 60 * 60 * 24)
      );

      const vpnName =
        cfg.package_name ||
        cfg.configName ||
        cfg.remark ||
        'FIREVPN Package';

      const vpnUuid = cfg.uuid || cfg.id;

      let targetType = '';
      let targetTitle = '';
      let targetMessage = '';

      if (daysLeft === 3) {
        targetType = 'expiry_3d';
        targetTitle = 'VPN Expires in 3 Days';
        targetMessage =
          `Your VPN configuration "${vpnName}" expires in 3 days. Renew now to avoid service interruption.`;
      } else if (daysLeft === 2) {
        targetType = 'expiry_2d';
        targetTitle = 'VPN Expires in 2 Days';
        targetMessage =
          `Your VPN configuration "${vpnName}" expires in 2 days. Renew now to avoid service interruption.`;
      } else if (daysLeft === 1) {
        targetType = 'expiry_1d';
        targetTitle = 'VPN Expires Tomorrow';
        targetMessage =
          `Urgent: Your VPN configuration "${vpnName}" expires tomorrow! Renew now to keep your connection active.`;
      } else if (daysLeft <= 0) {
        targetType = 'expiry_expired';
        targetTitle = 'VPN Expired';
        targetMessage =
          `Your VPN configuration "${vpnName}" has expired. Renew now to restore high-speed access.`;
      }

      if (!targetType) continue;

      // Preserve duplicate prevention, even if the old notification was read.
      const alreadyExists = existingNotifList.some((n: any) => {
        const matchType = n.type === targetType;
        const matchName = Boolean(
          n.message && n.message.includes(vpnName)
        );

        return matchType && matchName;
      });

      if (alreadyExists) continue;

      const created = await createCustomerNotification({
        userId: targetUserId,
        userEmail: userEmail || '',
        title: targetTitle,
        message: targetMessage,
        type: targetType,
        orderId: cfg.order_id || null,
        vpnName,
        vpnUuid
      });

      if (created) {
        existingNotifList.push(created);
      }

      // Preserve existing expiry email notifications.
      if (userEmail) {
        if (daysLeft > 0) {
          sendExpiryReminderEmail({
            userEmail,
            vpnAccountId: vpnUuid || cfg.id,
            packageName: vpnName,
            daysLeft,
            userId: targetUserId
          }).catch(error =>
            console.warn(
              '[NotificationService] Expiry email warning:',
              error
            )
          );
        } else {
          sendVpnExpiredEmail({
            userEmail,
            vpnAccountId: vpnUuid || cfg.id,
            packageName: vpnName,
            userId: targetUserId
          }).catch(error =>
            console.warn(
              '[NotificationService] Expired email warning:',
              error
            )
          );
        }
      }
    }
  } catch (error: any) {
    console.warn(
      '[NotificationService] Expiry notification sync error:',
      error.message || error
    );
  }
};

export const getUserNotifications = async (
  userId?: string,
  userEmail?: string
): Promise<any[]> => {
  console.log(
    `[NotificationService] Getting unread notifications for: ${userId}`
  );

  try {
    await checkAndCreateExpiryNotifications(userId, userEmail);

    const uId = userId ? String(userId).trim() : '';

    let resolvedEmailUserId = '';

    if (userEmail) {
      try {
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('email', userEmail)
          .maybeSingle();

        if (profile?.id) {
          resolvedEmailUserId = profile.id;
        } else {
          const { data: orderUser } = await supabaseAdmin
            .from('orders')
            .select('customer_id')
            .eq('email', userEmail)
            .not('customer_id', 'is', null)
            .neq('customer_id', 'N/A')
            .limit(1)
            .maybeSingle();

          if (orderUser?.customer_id) {
            resolvedEmailUserId = orderUser.customer_id;
          }
        }
      } catch (error: any) {
        console.warn(
          '[NotificationService] Email user resolution error:',
          error.message || error
        );
      }
    }

    const targetUserIds = new Set<string>();

    if (
      uId &&
      !['N/A', 'null', 'undefined'].includes(uId)
    ) {
      targetUserIds.add(uId);
    }

    if (
      resolvedEmailUserId &&
      !['N/A', 'null', 'undefined'].includes(resolvedEmailUserId)
    ) {
      targetUserIds.add(resolvedEmailUserId);
    }

    if (targetUserIds.size === 0) {
      return [];
    }

    // IMPORTANT: Return only unread notifications.
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select(
        'id, user_id, title, message, type, is_read, created_at'
      )
      .in('user_id', Array.from(targetUserIds))
      .eq('is_read', false)
      .order('created_at', { ascending: false });

    if (error) {
      console.error(
        '[NotificationService] Unread notification query error:',
        error.message || error
      );
      return [];
    }

    console.log(
      `[NotificationService] Found ${data?.length || 0} unread notifications`
    );

    return data || [];
  } catch (error: any) {
    console.error(
      '[NotificationService] getUserNotifications error:',
      error.message || error
    );
    return [];
  }
};

export const markNotificationAsRead = async (
  notificationId: string,
  userId?: string
): Promise<boolean> => {
  console.log(
    `[NotificationService] Marking notification ${notificationId} as read${userId ? ` for user ${userId}` : ''}`
  );

  try {
    if (!notificationId) {
      return false;
    }

    let query = supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notificationId)
      .eq('is_read', false);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query.select('id');

    if (error) {
      console.error(
        '[NotificationService] Mark as read database error:',
        error.message || error
      );
      return false;
    }

    return Boolean(data && data.length > 0);
  } catch (error: any) {
    console.error(
      '[NotificationService] Mark as read exception:',
      error.message || error
    );
    return false;
  }
};

export const deleteAllCustomerNotifications = async (userId: string): Promise<boolean> => {
  console.log(`[NotificationService] Deleting all notifications for user ${userId}`);

  try {
    const cleanUserId = userId ? String(userId).trim() : '';
    if (!cleanUserId || ['N/A', 'null', 'undefined', ''].includes(cleanUserId)) {
      return false;
    }

    const { error } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('user_id', cleanUserId);

    if (error) {
      console.error(
        '[NotificationService] Delete all notifications database error:',
        error.message || error
      );
      return false;
    }

    // Record deletion timestamp so automatic expiry synchronization does not recreate deleted notifications
    try {
      const { data: existingDoc } = await supabaseAdmin
        .from('settings')
        .select('data')
        .eq('id', 'deleted_notifications_state')
        .maybeSingle();
      const currentUsers = existingDoc?.data?.users || {};
      currentUsers[cleanUserId] = { deletedAt: Date.now() };
      await supabaseAdmin.from('settings').upsert({
        id: 'deleted_notifications_state',
        data: { users: currentUsers },
        updated_at: new Date().toISOString()
      });
    } catch (stateErr) {
      console.warn('[NotificationService] Could not persist deleted_notifications_state:', stateErr);
    }

    return true;
  } catch (error: any) {
    console.error(
      '[NotificationService] Delete all notifications exception:',
      error.message || error
    );
    return false;
  }
};

