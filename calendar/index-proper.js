#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { google } from 'googleapis';

// Google Calendar API setup
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly'
];

// Get OAuth tokens from environment variables
const getOAuth2Client = () => {
  // Check for tokens in various formats
  const accessToken = process.env.access_token || 
                      process.env.ACCESS_TOKEN ||
                      process.env.oauth_access_token ||
                      process.env.OAUTH_ACCESS_TOKEN;
                      
  const refreshToken = process.env.refresh_token || 
                       process.env.REFRESH_TOKEN ||
                       process.env.oauth_refresh_token ||
                       process.env.OAUTH_REFRESH_TOKEN;
  
  // Also check for Gmail-style uppercase env vars
  const clientId = process.env.CLIENT_ID || 
                   process.env.client_id;
                   
  const clientSecret = process.env.CLIENT_SECRET || 
                       process.env.client_secret;
  
  console.error('[Google Calendar] OAuth check:', {
    hasAccessToken: !!accessToken,
    hasRefreshToken: !!refreshToken,
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret
  });
  
  // If we have refresh token but no access token, that's OK - OAuth2 client will handle it
  if (!refreshToken && !accessToken) {
    console.error('[Google Calendar] ERROR: No OAuth tokens found');
    throw new Error('OAuth tokens not provided. Please authenticate with Google Calendar.');
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'http://localhost:3000/oauth2callback' // Redirect URI (not used for refresh)
  );
  
  // Set credentials - if only refresh token is available, that's fine
  const credentials = {};
  if (accessToken) credentials.access_token = accessToken;
  if (refreshToken) credentials.refresh_token = refreshToken;
  
  oauth2Client.setCredentials(credentials);
  console.error('[Google Calendar] OAuth client initialized');
  
  return oauth2Client;
};

// Initialize Google Calendar client
const getCalendarClient = () => {
  try {
    const auth = getOAuth2Client();
    return google.calendar({ version: 'v3', auth });
  } catch (error) {
    console.error('Failed to initialize Google Calendar client:', error.message);
    return null;
  }
};

// Create MCP server
const server = new McpServer({
  name: 'google-calendar-mcp',
  version: '1.0.0'
});

// Helper function to format responses
const formatResponse = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
});

// Helper function to handle API calls
const handleCalendarOperation = async (operation) => {
  try {
    const calendar = getCalendarClient();
    if (!calendar) {
      throw new Error('Google Calendar client not initialized. Please check OAuth credentials.');
    }
    return await operation(calendar);
  } catch (error) {
    console.error('Calendar operation failed:', error);
    throw error;
  }
};

// Register tools
server.tool(
  'list_calendars',
  'List all available calendars accessible by the authenticated user',
  {
    showHidden: z.boolean().optional().describe('Whether to show hidden calendars'),
    minAccessRole: z.enum(['freeBusyReader', 'reader', 'writer', 'owner']).optional().describe('Minimum access role for returned calendars')
  },
  async (params) => {
    return handleCalendarOperation(async (calendar) => {
      const { data } = await calendar.calendarList.list({
        showHidden: params.showHidden,
        minAccessRole: params.minAccessRole
      });
      return formatResponse(data);
    });
  }
);

server.tool(
  'get_calendar',
  'Get details of a specific calendar',
  {
    calendarId: z.string().describe('Calendar identifier. Use "primary" for the primary calendar.')
  },
  async (params) => {
    return handleCalendarOperation(async (calendar) => {
      const { data } = await calendar.calendars.get({
        calendarId: params.calendarId
      });
      return formatResponse(data);
    });
  }
);

server.tool(
  'list_events',
  'List events from a calendar',
  {
    calendarId: z.string().default('primary').describe('Calendar identifier. Defaults to "primary"'),
    timeMin: z.string().optional().describe('Lower bound for event start time (RFC3339 timestamp)'),
    timeMax: z.string().optional().describe('Upper bound for event start time (RFC3339 timestamp)'),
    maxResults: z.number().min(1).max(2500).optional().describe('Maximum number of events to return'),
    q: z.string().optional().describe('Free text search query'),
    showDeleted: z.boolean().optional().describe('Whether to include deleted events'),
    singleEvents: z.boolean().optional().describe('Whether to expand recurring events into instances'),
    orderBy: z.enum(['startTime', 'updated']).optional().describe('Order of events in the result')
  },
  async (params) => {
    return handleCalendarOperation(async (calendar) => {
      const { data } = await calendar.events.list({
        calendarId: params.calendarId,
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        maxResults: params.maxResults,
        q: params.q,
        showDeleted: params.showDeleted,
        singleEvents: params.singleEvents,
        orderBy: params.orderBy
      });
      return formatResponse(data);
    });
  }
);

server.tool(
  'get_event',
  'Get details of a specific event',
  {
    calendarId: z.string().default('primary').describe('Calendar identifier'),
    eventId: z.string().describe('Event identifier')
  },
  async (params) => {
    return handleCalendarOperation(async (calendar) => {
      const { data } = await calendar.events.get({
        calendarId: params.calendarId,
        eventId: params.eventId
      });
      return formatResponse(data);
    });
  }
);

server.tool(
  'create_event',
  'Create a new calendar event',
  {
    calendarId: z.string().default('primary').describe('Calendar identifier'),
    summary: z.string().describe('Event title'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    start: z.object({
      dateTime: z.string().optional().describe('Start time (RFC3339 timestamp)'),
      date: z.string().optional().describe('Start date (YYYY-MM-DD) for all-day events'),
      timeZone: z.string().optional().describe('Time zone (IANA Time Zone Database name)')
    }).describe('Event start time'),
    end: z.object({
      dateTime: z.string().optional().describe('End time (RFC3339 timestamp)'),
      date: z.string().optional().describe('End date (YYYY-MM-DD) for all-day events'),
      timeZone: z.string().optional().describe('Time zone (IANA Time Zone Database name)')
    }).describe('Event end time'),
    attendees: z.array(z.object({
      email: z.string().describe('Attendee email address'),
      displayName: z.string().optional().describe('Attendee display name'),
      optional: z.boolean().optional().describe('Whether attendance is optional'),
      responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']).optional()
    })).optional().describe('List of attendees'),
    reminders: z.object({
      useDefault: z.boolean().optional().describe('Whether to use default reminders'),
      overrides: z.array(z.object({
        method: z.enum(['email', 'popup']).describe('Reminder method'),
        minutes: z.number().min(0).max(40320).describe('Minutes before event')
      })).optional().describe('Custom reminder settings')
    }).optional().describe('Reminder configuration'),
    recurrence: z.array(z.string()).optional().describe('RRULE strings for recurring events'),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().describe('Whether to send notifications')
  },
  async (params) => {
    return handleCalendarOperation(async (calendar) => {
      const eventData = {
        summary: params.summary,
        description: params.description,
        location: params.location,
        start: params.start,
        end: params.end,
        attendees: params.attendees,
        reminders: params.reminders,
        recurrence: params.recurrence
      };

      const { data } = await calendar.events.insert({
        calendarId: params.calendarId,
        requestBody: eventData,
        sendUpdates: params.sendUpdates
      });
      return formatResponse(data);
    });
  }
);

server.tool(
  'update_event',
  'Update an existing calendar event',
  {
    calendarId: z.string().default('primary').describe('Calendar identifier'),
    eventId: z.string().describe('Event identifier'),
    summary: z.string().optional().describe('Event title'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    start: z.object({
      dateTime: z.string().optional(),
      date: z.string().optional(),
      timeZone: z.string().optional()
    }).optional().describe('Event start time'),
    end: z.object({
      dateTime: z.string().optional(),
      date: z.string().optional(),
      timeZone: z.string().optional()
    }).optional().describe('Event end time'),
    attendees: z.array(z.object({
      email: z.string(),
      displayName: z.string().optional(),
      optional: z.boolean().optional(),
      responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']).optional()
    })).optional().describe('List of attendees'),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().describe('Whether to send notifications')
  },
  async (params) => {
    return handleCalendarOperation(async (calendar) => {
      // First get the existing event
      const { data: existingEvent } = await calendar.events.get({
        calendarId: params.calendarId,
        eventId: params.eventId
      });

      // Merge updates with existing data
      const updatedEvent = {
        ...existingEvent,
        summary: params.summary || existingEvent.summary,
        description: params.description !== undefined ? params.description : existingEvent.description,
        location: params.location !== undefined ? params.location : existingEvent.location,
        start: params.start || existingEvent.start,
        end: params.end || existingEvent.end,
        attendees: params.attendees || existingEvent.attendees
      };

      const { data } = await calendar.events.update({
        calendarId: params.calendarId,
        eventId: params.eventId,
        requestBody: updatedEvent,
        sendUpdates: params.sendUpdates
      });
      return formatResponse(data);
    });
  }
);

server.tool(
  'delete_event',
  'Delete a calendar event',
  {
    calendarId: z.string().default('primary').describe('Calendar identifier'),
    eventId: z.string().describe('Event identifier'),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().describe('Whether to send cancellation notifications')
  },
  async (params) => {
    return handleCalendarOperation(async (calendar) => {
      await calendar.events.delete({
        calendarId: params.calendarId,
        eventId: params.eventId,
        sendUpdates: params.sendUpdates
      });
      return formatResponse({ success: true, message: `Event ${params.eventId} deleted successfully` });
    });
  }
);

server.tool(
  'quick_add_event',
  'Create an event using natural language',
  {
    calendarId: z.string().default('primary').describe('Calendar identifier'),
    text: z.string().describe('Natural language description of the event (e.g., "Dinner with John tomorrow at 7pm")')
  },
  async (params) => {
    return handleCalendarOperation(async (calendar) => {
      const { data } = await calendar.events.quickAdd({
        calendarId: params.calendarId,
        text: params.text
      });
      return formatResponse(data);
    });
  }
);

server.tool(
  'get_free_busy',
  'Check free/busy information for calendars',
  {
    timeMin: z.string().describe('Start of the interval (RFC3339 timestamp)'),
    timeMax: z.string().describe('End of the interval (RFC3339 timestamp)'),
    items: z.array(z.object({
      id: z.string().describe('Calendar identifier')
    })).describe('List of calendars to check'),
    timeZone: z.string().optional().describe('Time zone for the returned busy times')
  },
  async (params) => {
    return handleCalendarOperation(async (calendar) => {
      const { data } = await calendar.freebusy.query({
        requestBody: {
          timeMin: params.timeMin,
          timeMax: params.timeMax,
          items: params.items,
          timeZone: params.timeZone
        }
      });
      return formatResponse(data);
    });
  }
);

// Start the server
async function main() {
  // Debug: Log environment variables at startup
  console.error('[Google Calendar] Server starting...');
  console.error('[Google Calendar] Environment variables at startup:');
  const oauthVars = Object.keys(process.env)
    .filter(k => k.toLowerCase().includes('oauth') || k.toLowerCase().includes('token') || k.toLowerCase().includes('access') || k.toLowerCase().includes('refresh'))
    .reduce((acc, k) => {
      acc[k] = process.env[k] ? `${process.env[k].substring(0, 20)}...` : 'undefined';
      return acc;
    }, {});
  console.error('[Google Calendar] OAuth-related env vars:', JSON.stringify(oauthVars, null, 2));
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Google Calendar] MCP server running on stdio transport');
}

main().catch((error) => {
  console.error('[Google Calendar] Server startup error:', error);
  process.exit(1);
});