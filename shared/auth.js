import { google } from 'googleapis';

/**
 * Shared authentication helper for all Google services
 * This module provides a common OAuth2 client that can be used
 * by all Google service MCP servers (Calendar, Gmail, Drive, etc.)
 */

/**
 * Creates an OAuth2 client with the given credentials
 * @param {Object} credentials - The OAuth2 credentials
 * @param {string} credentials.access_token - The access token
 * @param {string} credentials.refresh_token - The refresh token
 * @param {string} credentials.client_id - The client ID (optional)
 * @param {string} credentials.client_secret - The client secret (optional)
 * @returns {google.auth.OAuth2} The configured OAuth2 client
 */
export function createAuthClient(credentials) {
  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    'https://app.serenitiesai.com/api/oauth/native/callback'
  );

  oauth2Client.setCredentials({
    access_token: credentials.access_token,
    refresh_token: credentials.refresh_token,
  });

  return oauth2Client;
}

/**
 * Creates a service client for a specific Google service
 * @param {string} serviceName - The name of the service (e.g., 'calendar', 'gmail', 'drive')
 * @param {string} version - The API version (e.g., 'v3', 'v1')
 * @param {google.auth.OAuth2} auth - The OAuth2 client
 * @returns {Object} The service client
 */
export function createServiceClient(serviceName, version, auth) {
  return google[serviceName]({ version, auth });
}

/**
 * Common error handler for Google API errors
 * @param {Error} error - The error from Google API
 * @returns {Object} Formatted error response for MCP
 */
export function handleGoogleError(error) {
  console.error('Google API Error:', error);
  
  if (error.code === 401) {
    return {
      error: 'Authentication failed. Please reconnect your Google account.',
      code: 'AUTH_FAILED'
    };
  }
  
  if (error.code === 403) {
    return {
      error: 'Permission denied. Please check your Google account permissions.',
      code: 'PERMISSION_DENIED'
    };
  }
  
  if (error.code === 404) {
    return {
      error: 'Resource not found.',
      code: 'NOT_FOUND'
    };
  }
  
  if (error.code === 429) {
    return {
      error: 'Rate limit exceeded. Please try again later.',
      code: 'RATE_LIMITED'
    };
  }
  
  return {
    error: error.message || 'An unknown error occurred',
    code: 'UNKNOWN_ERROR'
  };
}

export { google };