/** Auth validation rules from handoff §4.1. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string | null {
  if (!email.trim()) return 'Email is required';
  if (!EMAIL_RE.test(email.trim())) return 'Enter a valid email address';
  return null;
}

export function validatePasswordRequired(password: string): string | null {
  return password ? null : 'Password is required';
}

export function validatePasswordMin(password: string): string | null {
  if (!password) return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters';
  return null;
}

export function validateNameRequired(name: string): string | null {
  return name.trim() ? null : 'Name is required';
}
