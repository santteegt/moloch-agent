import { z } from 'zod';
import type { Config } from './config.js';
import { getNetwork } from './networks.js';

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

export type ServiceClient = {
  health(): Promise<unknown>;
  capabilities(): Promise<unknown>;
  dao(input: { dao: string }): Promise<unknown>;
  proposals(input: { dao: string; first: number; skip: number }): Promise<unknown>;
  proposal(input: { dao: string; proposal: string }): Promise<unknown>;
  members(input: { dao: string; first: number; skip: number }): Promise<unknown>;
  records(input: { dao: string; table: string; first: number; skip: number }): Promise<unknown>;
  pinJson(input: { name?: string; data: unknown }): Promise<unknown>;
};

export function createServiceClient(config: Config): ServiceClient {
  const base = getNetwork(config.chainId).serviceUrl;
  const chainId = config.chainId;

  return {
    health: () => getJson(`${base}/health`),
    capabilities: () => getJson(`${base}/capabilities`),
    dao: ({ dao }) => getJson(`${base}/dao/${chainId}/${normalizeDao(dao)}`),
    proposals: ({ dao, first, skip }) => getJson(`${base}/dao/${chainId}/${normalizeDao(dao)}/proposals?first=${first}&skip=${skip}`),
    proposal: ({ dao, proposal }) => getJson(`${base}/dao/${chainId}/${normalizeDao(dao)}/proposals/${proposal}`),
    members: ({ dao, first, skip }) => getJson(`${base}/dao/${chainId}/${normalizeDao(dao)}/members?first=${first}&skip=${skip}`),
    records: ({ dao, table, first, skip }) => getJson(`${base}/dao/${chainId}/${normalizeDao(dao)}/records?table=${encodeURIComponent(table)}&first=${first}&skip=${skip}`),
    pinJson: ({ name, data }) => postJson(`${base}/pin/json`, { name, data }),
  };
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  return parseResponse(response);
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = typeof body === 'object' && body && 'error' in body ? String(body.error) : response.statusText;
    throw new Error(error);
  }
  return body;
}

function normalizeDao(value: string): string {
  return addressSchema.parse(value).toLowerCase();
}
