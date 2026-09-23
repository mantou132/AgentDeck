import {
  type ImpactFeedbackStyle,
  type NotificationFeedbackType,
  impactFeedback as tauriImpactFeedback,
  notificationFeedback as tauriNotificationFeedback,
  selectionFeedback as tauriSelectionFeedback,
  vibrate as tauriVibrate,
} from '@tauri-apps/plugin-haptics';

export const hapticNotification = async (type: NotificationFeedbackType) => {
  try {
    await tauriNotificationFeedback(type);
  } catch {
    // Ignore unsupported environments (e.g. desktop/browser)
  }
};

export const hapticSuccess = () => hapticNotification('success');

export const hapticWarning = () => hapticNotification('warning');

export const hapticError = () => hapticNotification('error');

export const hapticSelection = async () => {
  try {
    await tauriSelectionFeedback();
  } catch {
    // Ignore unsupported environments (e.g. desktop/browser)
  }
};

export const hapticImpact = async (style: ImpactFeedbackStyle) => {
  try {
    await tauriImpactFeedback(style);
  } catch {
    // Ignore unsupported environments (e.g. desktop/browser)
  }
};

export const hapticVibrate = async (duration: number) => {
  try {
    await tauriVibrate(duration);
  } catch {
    // Ignore unsupported environments (e.g. desktop/browser)
  }
};
