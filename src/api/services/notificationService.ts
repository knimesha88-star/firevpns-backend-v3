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

export const createCustomerNotification = async (params: CreateNotificationParams): Promise<any> => {
  const { userId, userEmail, title, message, type = 'info', orderId, vpnName, vpnUuid } = params;

  console.log(`[NotificationService] [ENTER] createCustomerNotification called with:`, {
    userId,
    userEmail,
    title,
    type,
    orderId,
    vpnName,
    vpnUuid
  });

  let resolvedUserId = (userId && String(userId).trim() !== 'N/A' && String(userId).trim() !== 'null' && String(userId).trim() !== 'undefined' && String(userId).trim() !== '') ? String(userId).trim() : null;
  if (!resolvedUserId && userEmail) {
    try {
      console.log(`[NotificationService] Attempting to resolve user ID for email: ${userEmail}`);
      const { data: profile } = await supabaseAdmin.from('profiles').select('id').eq('email', userEmail).maybeSingle();
      if (profile?.id) {
        resolvedUserId = profile.id;
        console.log(`[NotificationService] Resolved user ID from profiles: ${resolvedUserId}`);
      } else {
        const { data: orderUser } = await supabaseAdmin.from('orders').select('customer_id').eq('email', userEmail).not('customer_id', 'is', null).neq('customer_id', 'N/A').limit(1).maybeSingle();
        if (orderUser?.customer_id) {
          resolvedUserId = orderUser.customer_id;
          console.log(`[NotificationService] Resolved user ID from orders: ${resolvedUserId}`);
        }
      }
    } catch (e: any) {
      console.warn('[NotificationService] Error resolving userId from email:', e.message || e);
    }
  }

  let finalMessage = message;
  if (vpnName && !message.includes(vpnName)) {
    finalMessage = `${message} (VPN: ${vpnName})`;
  }

  // NOTE: Based on database audit, only id, user_id, title, message, type, is_read, and created_at columns exist in public.notifications.
  // We MUST exclude missing columns like user_email, email, read, order_id, updated_at to prevent PostgreSQL errors.
  const payload: any = {
    user_id: resolvedUserId || null,
    title,
    message: finalMessage,
    type,
    is_read: false,
    created_at: new Date().toISOString()
  };

  console.log('[NotificationService] Inserting notification payload:', JSON.stringify(payload, null, 2));

  try {
    const { data, error } = await supabaseAdmin.from('notifications').insert(payload).select().maybeSingle();

    if (error) {
      console.error(`[NotificationService] Database error inserting notification for ${userEmail || resolvedUserId}:`, error.message || error);
      throw error;
    }

    console.log(`[NotificationService] Successfully inserted notification! Result:`, data);
    return data;
  } catch (err: any) {
    console.error(`[NotificationService] Exception during notification insert for ${userEmail || resolvedUserId}:`, err.message || err);
    throw err;
  }
};

export const checkAndCreateExpiryNotifications = async (userId?: string, userEmail?: string): Promise<void> => {
  if (!userId && !userEmail) return;

  console.log(`[NotificationService] [ENTER] checkAndCreateExpiryNotifications for userId: ${userId}, userEmail: ${userEmail}`);
  try {
    let query = supabaseAdmin.from('vpn_configs').select('*');
    if (userId) {
      query = query.eq('customer_uid', userId);
    } else {
      return;
    }

    const { data: configs, error: configErr } = await query;
    if (configErr) {
      console.warn('[NotificationService] Error querying vpn_configs:', configErr.message || configErr);
      return;
    }
    if (!configs || configs.length === 0) return;

    let targetUserId = userId;
    if (!targetUserId && userEmail) {
      try {
        const { data: profile } = await supabaseAdmin.from('profiles').select('id').eq('email', userEmail).maybeSingle();
        if (profile?.id) {
          targetUserId = profile.id;
        } else {
          const { data: orderUser } = await supabaseAdmin.from('orders').select('customer_id').eq('email', userEmail).limit(1).maybeSingle();
          if (orderUser?.customer_id) {
            targetUserId = orderUser.customer_id;
          }
        }
      } catch (e: any) {
        console.warn('[NotificationService] Error resolving user ID during checkAndCreateExpiryNotifications:', e.message || e);
      }
    }

    if (!targetUserId) return;

    const { data: existingNotifs, error: notifErr } = await supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('user_id', targetUserId);

    if (notifErr) {
      console.warn('[NotificationService] Error querying existing notifications:', notifErr.message || notifErr);
      return;
    }

    const existingNotifList = existingNotifs || [];
    const now = Date.now();

    for (const cfg of configs) {
      const expVal = cfg.expiry_date || cfg.expiry_time || cfg.expiryDate || cfg.expiryTime;
      if (!expVal) continue;

      let expMs: number | null = null;
      if (typeof expVal === 'number') {
        expMs = expVal < 10000000000 ? expVal * 1000 : expVal;
      } else {
        expMs = new Date(expVal).getTime();
      }

      if (!expMs || isNaN(expMs)) continue;

      const diffMs = expMs - now;
      const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      const vpnName = cfg.package_name || cfg.configName || cfg.remark || 'FIREVPN Package';
      const vpnUuid = cfg.uuid || cfg.id;

      let targetType = '';
      let targetTitle = '';
      let targetMessage = '';

      if (daysLeft === 3) {
        targetType = 'expiry_3d';
        targetTitle = 'VPN Expires in 3 Days';
        targetMessage = `Your VPN configuration "${vpnName}" expires in 3 days. Renew now to avoid service interruption.`;
      } else if (daysLeft === 2) {
        targetType = 'expiry_2d';
        targetTitle = 'VPN Expires in 2 Days';
        targetMessage = `Your VPN configuration "${vpnName}" expires in 2 days. Renew now to avoid service interruption.`;
      } else if (daysLeft === 1) {
        targetType = 'expiry_1d';
        targetTitle = 'VPN Expires Tomorrow';
        targetMessage = `Urgent: Your VPN configuration "${vpnName}" expires tomorrow! Renew now to keep your connection active.`;
      } else if (daysLeft <= 0) {
        targetType = 'expiry_expired';
        targetTitle = 'VPN Expired';
        targetMessage = `Your VPN configuration "${vpnName}" has expired. Renew now to restore high-speed access.`;
      }

      if (!targetType) continue;

      const alreadyExists = existingNotifList.some((n: any) => {
        const matchType = n.type === targetType;
        const matchName = (n.message && n.message.includes(vpnName)) || (n.title && n.title === targetTitle);
        return matchType && matchName;
      });

      if (!alreadyExists) {
        await createCustomerNotification({
          userId: targetUserId,
          userEmail: userEmail || '',
          title: targetTitle,
          message: targetMessage,
          type: targetType,
          orderId: cfg.order_id || null,
          vpnName: vpnName,
          vpnUuid: vpnUuid
        });

        // Trigger Email Notification
        if (userEmail) {
          if (daysLeft > 0) {
            sendExpiryReminderEmail({
              userEmail: userEmail,
              vpnAccountId: vpnUuid || cfg.id,
              packageName: vpnName,
              daysLeft: daysLeft,
              userId: targetUserId
            }).catch(e => console.warn('[NotificationService] Expiry reminder email warning:', e));
          } else {
            sendVpnExpiredEmail({
              userEmail: userEmail,
              vpnAccountId: vpnUuid || cfg.id,
              packageName: vpnName,
              userId: targetUserId
            }).catch(e => console.warn('[NotificationService] VPN expired email warning:', e));
          }
        }
      }
    }
  } catch (err: any) {
    console.warn('[NotificationService] Error syncing expiry notifications:', err.message || err);
  }
};

export const getUserNotifications = async (userId?: string, userEmail?: string): Promise<any[]> => {
  console.log(`[NotificationService] [ENTER] getUserNotifications for userId: ${userId}, userEmail: ${userEmail}`);
  try {
    await checkAndCreateExpiryNotifications(userId, userEmail);

    const { data: allNotifs, error } = await supabaseAdmin.from('notifications').select('*').order('created_at', { ascending: false });
    if (error || !allNotifs) {
      if (error) {
        console.error('[NotificationService] Error querying notifications table:', error.message || error);
      }
      return [];
    }

    const uId = userId ? String(userId).trim() : '';
    let resolvedEmailUserId = '';
    if (userEmail) {
      try {
        const { data: profile } = await supabaseAdmin.from('profiles').select('id').eq('email', userEmail).maybeSingle();
        if (profile?.id) {
          resolvedEmailUserId = profile.id;
        } else {
          const { data: orderUser } = await supabaseAdmin.from('orders').select('customer_id').eq('email', userEmail).not('customer_id', 'is', null).neq('customer_id', 'N/A').limit(1).maybeSingle();
          if (orderUser?.customer_id) {
            resolvedEmailUserId = orderUser.customer_id;
          }
        }
      } catch (e: any) {
        console.warn('[NotificationService] Error resolving user ID during getUserNotifications:', e.message || e);
      }
    }

    const targetUserIds = new Set<string>();
    if (uId && uId !== 'N/A' && uId !== 'null' && uId !== 'undefined') targetUserIds.add(uId);
    if (resolvedEmailUserId && resolvedEmailUserId !== 'N/A' && resolvedEmailUserId !== 'null' && resolvedEmailUserId !== 'undefined') targetUserIds.add(resolvedEmailUserId);

    console.log(`[NotificationService] Filtering all notifications for user IDs:`, Array.from(targetUserIds));

    const filtered = allNotifs.filter((item: any) => {
      const itemUserId = String(item.user_id || '').trim();
      return targetUserIds.has(itemUserId);
    });

    console.log(`[NotificationService] Found ${filtered.length} notifications for user IDs: ${Array.from(targetUserIds).join(', ')}`);
    return filtered;
  } catch (err: any) {
    console.warn('[NotificationService] Error in getUserNotifications:', err.message || err);
    return [];
  }
};

export const markNotificationAsRead = async (notificationId: string): Promise<boolean> => {
  console.log(`[NotificationService] [ENTER] markNotificationAsRead for ID: ${notificationId}`);
  try {
    const { error } = await supabaseAdmin.from('notifications').update({
      is_read: true
    }).eq('id', notificationId);

    if (error) {
      console.error(`[NotificationService] Database error marking notification ${notificationId} as read:`, error.message || error);
      return false;
    }
    console.log(`[NotificationService] Successfully marked notification ${notificationId} as read`);
    return true;
  } catch (err: any) {
    console.warn('[NotificationService] Exception marking notification as read:', err.message || err);
    return false;
  }
};
