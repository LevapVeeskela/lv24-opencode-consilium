export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export { isRecord } from '../../shared/record.js';

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolInputError(`"${key}" must be a string`);
  }
  return value;
}

export function requireNonEmptyString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value.trim().length === 0) {
    throw new ToolInputError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export function optionalStringArray(
  args: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ToolInputError(`"${key}" must be an array of strings`);
  }
  const items: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') {
      throw new ToolInputError(`"${key}" must be an array of strings`);
    }
    items.push(item);
  }
  return items;
}

export function optionalPositiveNumber(
  args: Record<string, unknown>,
  key: string
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ToolInputError(`"${key}" must be a positive number`);
  }
  return value;
}

export function optionalNonNegativeNumber(
  args: Record<string, unknown>,
  key: string
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ToolInputError(`"${key}" must be a number >= 0`);
  }
  return value;
}

export function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ToolInputError(`"${key}" must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function optionalBoolean(
  args: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ToolInputError(`"${key}" must be a boolean`);
  }
  return value;
}

export function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ToolInputError(`"${key}" must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}
