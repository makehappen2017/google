#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createAuthClient, createServiceClient, handleGoogleError } from '../shared/auth.js';

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
                   process.env.client_id ||
                   process.env.GOOGLE_CLIENT_ID;
                   
  const clientSecret = process.env.CLIENT_SECRET || 
                       process.env.client_secret ||
                       process.env.GOOGLE_CLIENT_SECRET;
  
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

  // Use shared auth helper
  return createAuthClient({
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });
};

// Initialize Google Calendar client
const getCalendarClient = () => {
  try {
    const auth = getOAuth2Client();
    return createServiceClient('calendar', 'v3', auth);
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
    // Use shared error handler
    const errorResponse = handleGoogleError(error);
    throw new Error(errorResponse.error);
  }
};

// Tool Schemas
const listEventsSchema = z.object({
  calendarId: z.string().default('primary').describe('Calendar ID (default: primary)'),
  maxResults: z.number().min(1).max(2500).default(10).describe('Maximum number of events'),
  timeMin: z.string().optional().describe('Lower bound for event start time (RFC3339)'),
  timeMax: z.string().optional().describe('Upper bound for event start time (RFC3339)'),
  q: z.string().optional().describe('Free text search query'),
  orderBy: z.enum(['startTime', 'updated']).default('startTime').describe('Order of events'),
  singleEvents: z.boolean().default(true).describe('Expand recurring events')
});

const getEventSchema = z.object({
  calendarId: z.string().default('primary').describe('Calendar ID'),
  eventId: z.string().describe('Event ID')
});

const createEventSchema = z.object({
  calendarId: z.string().default('primary').describe('Calendar ID'),
  summary: z.string().describe('Event title'),
  description: z.string().optional().describe('Event description'),
  location: z.string().optional().describe('Event location'),
  start: z.object({
    dateTime: z.string().optional().describe('Start time (RFC3339)'),
    date: z.string().optional().describe('Start date (YYYY-MM-DD) for all-day events'),
    timeZone: z.string().optional().describe('Time zone')
  }).describe('Event start time'),
  end: z.object({
    dateTime: z.string().optional().describe('End time (RFC3339)'),
    date: z.string().optional().describe('End date (YYYY-MM-DD) for all-day events'),
    timeZone: z.string().optional().describe('Time zone')
  }).describe('Event end time'),
  attendees: z.array(z.object({
    email: z.string().describe('Attendee email'),
    displayName: z.string().optional(),
    optional: z.boolean().optional(),
    responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']).optional()
  })).optional().describe('Event attendees'),
  reminders: z.object({
    useDefault: z.boolean().optional(),
    overrides: z.array(z.object({
      method: z.enum(['email', 'popup']),
      minutes: z.number()
    })).optional()
  }).optional().describe('Event reminders'),
  recurrence: z.array(z.string()).optional().describe('Recurrence rules (RRULE format)')
});

const updateEventSchema = z.object({
  calendarId: z.string().default('primary').describe('Calendar ID'),
  eventId: z.string().describe('Event ID'),
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
  })).optional().describe('Event attendees'),
  reminders: z.object({
    useDefault: z.boolean().optional(),
    overrides: z.array(z.object({
      method: z.enum(['email', 'popup']),
      minutes: z.number()
    })).optional()
  }).optional().describe('Event reminders')
});

const deleteEventSchema = z.object({
  calendarId: z.string().default('primary').describe('Calendar ID'),
  eventId: z.string().describe('Event ID'),
  sendNotifications: z.boolean().default(false).describe('Send notifications to attendees')
});

const listCalendarsSchema = z.object({
  minAccessRole: z.enum(['freeBusyReader', 'reader', 'writer', 'owner']).optional(),
  showDeleted: z.boolean().default(false),
  showHidden: z.boolean().default(false)
});

const getCalendarSchema = z.object({
  calendarId: z.string().describe('Calendar identifier. Use "primary" for the primary calendar.')
});

const quickAddEventSchema = z.object({
  calendarId: z.string().default('primary').describe('Calendar identifier'),
  text: z.string().describe('Natural language description of the event (e.g., "Dinner with John tomorrow at 7pm")')
});

const getFreeBusySchema = z.object({
  timeMin: z.string().describe('Start of the interval (RFC3339 timestamp)'),
  timeMax: z.string().describe('End of the interval (RFC3339 timestamp)'),
  items: z.array(z.object({
    id: z.string().describe('Calendar identifier')
  })).describe('List of calendars to check'),
  timeZone: z.string().optional().describe('Time zone for the returned busy times')
});

// Register tools
server.tool('calendar_list_events', 'List calendar events', listEventsSchema, async (args) => {
  return handleCalendarOperation(async (calendar) => {
    const response = await calendar.events.list({
      calendarId: args.calendarId,
      maxResults: args.maxResults,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      q: args.q,
      orderBy: args.orderBy,
      singleEvents: args.singleEvents
    });
    
    return formatResponse({
      events: response.data.items || [],
      nextPageToken: response.data.nextPageToken,
      summary: response.data.summary,
      updated: response.data.updated
    });
  });
});

server.tool('calendar_get_event', 'Get a specific calendar event', getEventSchema, async (args) => {
  return handleCalendarOperation(async (calendar) => {
    const response = await calendar.events.get({
      calendarId: args.calendarId,
      eventId: args.eventId
    });
    
    return formatResponse(response.data);
  });
});

server.tool('calendar_create_event', 'Create a new calendar event', createEventSchema, async (args) => {
  return handleCalendarOperation(async (calendar) => {
    const eventData = {
      summary: args.summary,
      description: args.description,
      location: args.location,
      start: args.start,
      end: args.end,
      attendees: args.attendees,
      reminders: args.reminders,
      recurrence: args.recurrence
    };
    
    // Remove undefined fields
    Object.keys(eventData).forEach(key => {
      if (eventData[key] === undefined) {
        delete eventData[key];
      }
    });
    
    const response = await calendar.events.insert({
      calendarId: args.calendarId,
      requestBody: eventData
    });
    
    return formatResponse({
      success: true,
      event: response.data,
      htmlLink: response.data.htmlLink
    });
  });
});

server.tool('calendar_update_event', 'Update an existing calendar event', updateEventSchema, async (args) => {
  return handleCalendarOperation(async (calendar) => {
    // First get the existing event
    const existing = await calendar.events.get({
      calendarId: args.calendarId,
      eventId: args.eventId
    });
    
    // Merge with updates
    const updatedEvent = {
      ...existing.data,
      ...Object.fromEntries(
        Object.entries(args).filter(([key, value]) => 
          value !== undefined && key !== 'calendarId' && key !== 'eventId'
        )
      )
    };
    
    const response = await calendar.events.update({
      calendarId: args.calendarId,
      eventId: args.eventId,
      requestBody: updatedEvent
    });
    
    return formatResponse({
      success: true,
      event: response.data,
      htmlLink: response.data.htmlLink
    });
  });
});

server.tool('calendar_delete_event', 'Delete a calendar event', deleteEventSchema, async (args) => {
  return handleCalendarOperation(async (calendar) => {
    await calendar.events.delete({
      calendarId: args.calendarId,
      eventId: args.eventId,
      sendNotifications: args.sendNotifications
    });
    
    return formatResponse({
      success: true,
      message: `Event ${args.eventId} deleted successfully`
    });
  });
});

server.tool('calendar_list_calendars', 'List available calendars', listCalendarsSchema, async (args) => {
  return handleCalendarOperation(async (calendar) => {
    const response = await calendar.calendarList.list({
      minAccessRole: args.minAccessRole,
      showDeleted: args.showDeleted,
      showHidden: args.showHidden
    });
    
    return formatResponse({
      calendars: response.data.items || [],
      nextPageToken: response.data.nextPageToken
    });
  });
});

server.tool('calendar_get_calendar', 'Get details of a specific calendar', getCalendarSchema, async (args) => {
  return handleCalendarOperation(async (calendar) => {
    const response = await calendar.calendars.get({
      calendarId: args.calendarId
    });
    
    return formatResponse(response.data);
  });
});

server.tool('calendar_quick_add', 'Create an event using natural language', quickAddEventSchema, async (args) => {
  return handleCalendarOperation(async (calendar) => {
    const response = await calendar.events.quickAdd({
      calendarId: args.calendarId,
      text: args.text
    });
    
    return formatResponse({
      success: true,
      event: response.data,
      htmlLink: response.data.htmlLink
    });
  });
});

server.tool('calendar_get_free_busy', 'Check free/busy information for calendars', getFreeBusySchema, async (args) => {
  return handleCalendarOperation(async (calendar) => {
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        items: args.items,
        timeZone: args.timeZone
      }
    });
    
    return formatResponse(response.data);
  });
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Google Calendar MCP] Server running on stdio transport');
}

main().catch((error) => {
  console.error('[Google Calendar MCP] Fatal error:', error);
  process.exit(1);
});