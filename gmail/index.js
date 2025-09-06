#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { createAuthClient } from '../shared/auth.js';

// Gmail API setup
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic'
];

// Get OAuth tokens from environment variables
const getOAuth2Client = () => {
  const accessToken = process.env.access_token || 
                      process.env.ACCESS_TOKEN ||
                      process.env.oauth_access_token ||
                      process.env.OAUTH_ACCESS_TOKEN;
                      
  const refreshToken = process.env.refresh_token || 
                       process.env.REFRESH_TOKEN ||
                       process.env.oauth_refresh_token ||
                       process.env.OAUTH_REFRESH_TOKEN;
  
  const clientId = process.env.CLIENT_ID || 
                   process.env.client_id ||
                   process.env.GOOGLE_CLIENT_ID;
                   
  const clientSecret = process.env.CLIENT_SECRET || 
                       process.env.client_secret ||
                       process.env.GOOGLE_CLIENT_SECRET;
  
  console.error('[Gmail MCP] OAuth check:', {
    hasAccessToken: !!accessToken,
    hasRefreshToken: !!refreshToken,
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret
  });
  
  if (!refreshToken && !accessToken) {
    console.error('[Gmail MCP] ERROR: No OAuth tokens found');
    throw new Error('OAuth tokens not provided. Please authenticate with Gmail.');
  }

  return createAuthClient({
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });
};

// Initialize Gmail client
const getGmailClient = () => {
  try {
    const auth = getOAuth2Client();
    return google.gmail({ version: 'v1', auth });
  } catch (error) {
    console.error('Failed to initialize Gmail client:', error.message);
    return null;
  }
};

// Create MCP server
const server = new McpServer({
  name: 'gmail-mcp',
  version: '1.0.0'
});

// Helper function to format responses
const formatResponse = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
});

// Helper function to handle API calls
const handleGmailOperation = async (operation) => {
  try {
    const gmail = getGmailClient();
    if (!gmail) {
      throw new Error('Gmail client not initialized. Please check OAuth credentials.');
    }
    return await operation(gmail);
  } catch (error) {
    console.error('Gmail operation failed:', error);
    throw error;
  }
};

// Helper to decode message body
const decodeMessageBody = (message) => {
  let body = '';
  
  if (message.payload) {
    // Handle multipart messages
    const findTextPart = (parts) => {
      if (!parts) return '';
      
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) {
          const text = findTextPart(part.parts);
          if (text) return text;
        }
      }
      return '';
    };
    
    // Try to get text/plain content
    if (message.payload.parts) {
      body = findTextPart(message.payload.parts);
    } else if (message.payload.body?.data) {
      body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    }
  }
  
  return body;
};

// Extract email headers
const extractHeaders = (headers) => {
  const result = {};
  if (!headers) return result;
  
  for (const header of headers) {
    result[header.name.toLowerCase()] = header.value;
  }
  return result;
};

// ==================== TOOL DEFINITIONS ====================

// List emails/messages
server.tool(
  'gmail_list_messages',
  'List emails from Gmail inbox',
  {
    query: z.string().optional().describe('Gmail search query (e.g., "from:john@example.com", "is:unread", "subject:meeting")'),
    labelIds: z.array(z.string()).optional().describe('Filter by label IDs (e.g., ["INBOX", "UNREAD"])'),
    maxResults: z.number().min(1).max(500).default(20).describe('Maximum number of messages to return'),
    pageToken: z.string().optional().describe('Page token for pagination'),
    includeSpamTrash: z.boolean().default(false).describe('Include messages from SPAM and TRASH')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.list({
        userId: 'me',
        q: params.query,
        labelIds: params.labelIds,
        maxResults: params.maxResults,
        pageToken: params.pageToken,
        includeSpamTrash: params.includeSpamTrash
      });
      
      // Get basic info for each message
      const messages = [];
      if (data.messages) {
        for (const msg of data.messages.slice(0, params.maxResults)) {
          const { data: fullMessage } = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date']
          });
          
          const headers = extractHeaders(fullMessage.payload?.headers);
          messages.push({
            id: fullMessage.id,
            threadId: fullMessage.threadId,
            from: headers.from,
            to: headers.to,
            subject: headers.subject,
            date: headers.date,
            snippet: fullMessage.snippet,
            labelIds: fullMessage.labelIds
          });
        }
      }
      
      return formatResponse({
        messages,
        nextPageToken: data.nextPageToken,
        resultSizeEstimate: data.resultSizeEstimate
      });
    });
  }
);

// Get message (lean - only essential information)
server.tool(
  'gmail_get_message',
  'Get email message with essential information only',
  {
    messageId: z.string().describe('The ID of the message to retrieve')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.get({
        userId: 'me',
        id: params.messageId,
        format: 'full'
      });
      
      const headers = extractHeaders(data.payload?.headers);
      const body = decodeMessageBody(data);
      
      // Extract attachment information
      const attachments = [];
      if (data.payload) {
        const extractAttachments = (part) => {
          if (part.filename && part.body && part.body.attachmentId) {
            attachments.push({
              filename: part.filename,
              mimeType: part.mimeType,
              size: part.body.size,
              attachmentId: part.body.attachmentId
            });
          }
          if (part.parts) {
            part.parts.forEach(extractAttachments);
          }
        };
        extractAttachments(data.payload);
      }
      
      // Build lean response with only essential headers
      const response = {
        id: data.id,
        threadId: data.threadId,
        labelIds: data.labelIds,
        snippet: data.snippet,
        from: headers.from,
        to: headers.to,
        subject: headers.subject,
        date: headers.date,
        body: body
      };
      
      // Add optional headers only if they exist
      if (headers.cc) response.cc = headers.cc;
      if (headers.bcc) response.bcc = headers.bcc;
      if (headers['reply-to']) response.replyTo = headers['reply-to'];
      
      // Add attachments only if present
      if (attachments.length > 0) {
        response.attachments = attachments;
      }
      
      return formatResponse(response);
    });
  }
);

// Download attachment from a message
server.tool(
  'gmail_get_attachment',
  'Download an attachment from an email message',
  {
    messageId: z.string().describe('The ID of the message containing the attachment'),
    attachmentId: z.string().describe('The ID of the attachment to download (get from gmail_get_message)')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      // First get the message to find attachment metadata
      const { data: message } = await gmail.users.messages.get({
        userId: 'me',
        id: params.messageId,
        format: 'full'
      });
      
      // Find the attachment info from message parts
      let attachmentInfo = null;
      const findAttachment = (part) => {
        if (part.body?.attachmentId === params.attachmentId) {
          attachmentInfo = {
            filename: part.filename,
            mimeType: part.mimeType,
            size: part.body.size // Use size from message part
          };
          return true;
        }
        if (part.parts) {
          for (const subPart of part.parts) {
            if (findAttachment(subPart)) return true;
          }
        }
        return false;
      };
      
      if (message.payload) {
        findAttachment(message.payload);
      }
      
      // Now fetch the actual attachment data
      const { data } = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: params.messageId,
        id: params.attachmentId
      });
      
      // Gmail returns URL-safe base64, convert to standard base64 if needed
      let base64Data = data.data;
      if (base64Data) {
        base64Data = base64Data
          .replace(/-/g, '+')
          .replace(/_/g, '/');
      }
      
      return formatResponse({
        attachmentId: params.attachmentId,
        filename: attachmentInfo?.filename || 'attachment',
        mimeType: attachmentInfo?.mimeType || 'application/octet-stream',
        size: attachmentInfo?.size || data.size,
        data: base64Data // Standard base64 encoded content
      });
    });
  }
);

// Get message with HTML
server.tool(
  'gmail_get_message_with_html',
  'Get email message including both plain text and HTML body',
  {
    messageId: z.string().describe('The ID of the message to retrieve')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.get({
        userId: 'me',
        id: params.messageId,
        format: 'full'
      });
      
      const headers = extractHeaders(data.payload?.headers);
      const plainBody = decodeMessageBody(data);
      
      // Extract HTML body
      let htmlBody = '';
      if (data.payload) {
        const findHtmlPart = (parts) => {
          if (!parts) return '';
          
          for (const part of parts) {
            if (part.mimeType === 'text/html' && part.body?.data) {
              return Buffer.from(part.body.data, 'base64').toString('utf-8');
            }
            if (part.parts) {
              const html = findHtmlPart(part.parts);
              if (html) return html;
            }
          }
          return '';
        };
        
        if (data.payload.parts) {
          htmlBody = findHtmlPart(data.payload.parts);
        } else if (data.payload.mimeType === 'text/html' && data.payload.body?.data) {
          htmlBody = Buffer.from(data.payload.body.data, 'base64').toString('utf-8');
        }
      }
      
      // Extract attachments
      const attachments = [];
      if (data.payload) {
        const extractAttachments = (part) => {
          if (part.filename && part.body && part.body.attachmentId) {
            attachments.push({
              filename: part.filename,
              mimeType: part.mimeType,
              size: part.body.size,
              attachmentId: part.body.attachmentId
            });
          }
          if (part.parts) {
            part.parts.forEach(extractAttachments);
          }
        };
        extractAttachments(data.payload);
      }
      
      // Build response with essential headers only
      const response = {
        id: data.id,
        threadId: data.threadId,
        labelIds: data.labelIds,
        snippet: data.snippet,
        from: headers.from,
        to: headers.to,
        subject: headers.subject,
        date: headers.date,
        body: plainBody,
        bodyHtml: htmlBody
      };
      
      // Add optional headers only if they exist
      if (headers.cc) response.cc = headers.cc;
      if (headers.bcc) response.bcc = headers.bcc;
      if (headers['reply-to']) response.replyTo = headers['reply-to'];
      
      // Add attachments only if present
      if (attachments.length > 0) {
        response.attachments = attachments;
      }
      
      return formatResponse(response);
    });
  }
);

// Send an email (with optional attachments)
server.tool(
  'gmail_send_message',
  'Send an email message with optional attachments',
  {
    to: z.string().describe('Recipient email address(es), comma-separated for multiple'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text or HTML)'),
    cc: z.string().optional().describe('CC recipients, comma-separated'),
    bcc: z.string().optional().describe('BCC recipients, comma-separated'),
    replyTo: z.string().optional().describe('Reply-to email address'),
    isHtml: z.boolean().default(false).describe('Whether the body is HTML'),
    attachments: z.array(z.object({
      filename: z.string().describe('Name of the file'),
      mimeType: z.string().describe('MIME type (e.g., "application/pdf", "image/png")'),
      content: z.string().describe('Base64 encoded file content')
    })).optional().describe('Array of file attachments')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      let message;
      
      // If we have attachments, create a multipart message
      if (params.attachments && params.attachments.length > 0) {
        const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const messageParts = [
          `To: ${params.to}`,
          `Subject: ${params.subject}`
        ];
        
        if (params.cc) messageParts.push(`Cc: ${params.cc}`);
        if (params.bcc) messageParts.push(`Bcc: ${params.bcc}`);
        if (params.replyTo) messageParts.push(`Reply-To: ${params.replyTo}`);
        
        // Set multipart mixed content type
        messageParts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
        messageParts.push('');
        
        // Add text/html body part
        messageParts.push(`--${boundary}`);
        if (params.isHtml) {
          messageParts.push('Content-Type: text/html; charset=utf-8');
        } else {
          messageParts.push('Content-Type: text/plain; charset=utf-8');
        }
        messageParts.push('Content-Transfer-Encoding: base64');
        messageParts.push('');
        messageParts.push(Buffer.from(params.body).toString('base64'));
        
        // Add each attachment
        for (const attachment of params.attachments) {
          messageParts.push('');
          messageParts.push(`--${boundary}`);
          messageParts.push(`Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`);
          messageParts.push('Content-Transfer-Encoding: base64');
          messageParts.push(`Content-Disposition: attachment; filename="${attachment.filename}"`);
          messageParts.push('');
          messageParts.push(attachment.content);
        }
        
        // Close the multipart message
        messageParts.push('');
        messageParts.push(`--${boundary}--`);
        
        message = messageParts.join('\n');
      } else {
        // Simple message without attachments (existing logic)
        const messageParts = [
          `To: ${params.to}`,
          `Subject: ${params.subject}`
        ];
        
        if (params.cc) messageParts.push(`Cc: ${params.cc}`);
        if (params.bcc) messageParts.push(`Bcc: ${params.bcc}`);
        if (params.replyTo) messageParts.push(`Reply-To: ${params.replyTo}`);
        
        if (params.isHtml) {
          messageParts.push('Content-Type: text/html; charset=utf-8');
        } else {
          messageParts.push('Content-Type: text/plain; charset=utf-8');
        }
        
        messageParts.push('');
        messageParts.push(params.body);
        
        message = messageParts.join('\n');
      }
      
      const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      
      const { data } = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage
        }
      });
      
      return formatResponse({
        success: true,
        messageId: data.id,
        threadId: data.threadId,
        labelIds: data.labelIds,
        attachmentCount: params.attachments ? params.attachments.length : 0
      });
    });
  }
);

// Reply to an email
server.tool(
  'gmail_reply_to_message',
  'Reply to an existing email thread',
  {
    messageId: z.string().describe('ID of the message to reply to'),
    body: z.string().describe('Reply message body'),
    replyAll: z.boolean().default(false).describe('Reply to all recipients'),
    isHtml: z.boolean().default(false).describe('Whether the body is HTML')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      // Get original message
      const { data: originalMessage } = await gmail.users.messages.get({
        userId: 'me',
        id: params.messageId,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID']
      });
      
      const headers = extractHeaders(originalMessage.payload?.headers);
      
      // Construct reply
      const to = headers.from;
      const subject = headers.subject?.startsWith('Re:') ? headers.subject : `Re: ${headers.subject}`;
      
      const messageParts = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `In-Reply-To: ${headers['message-id']}`,
        `References: ${headers['message-id']}`
      ];
      
      if (params.replyAll && headers.cc) {
        messageParts.push(`Cc: ${headers.cc}`);
      }
      
      if (params.isHtml) {
        messageParts.push('Content-Type: text/html; charset=utf-8');
      } else {
        messageParts.push('Content-Type: text/plain; charset=utf-8');
      }
      
      messageParts.push('');
      messageParts.push(params.body);
      
      const message = messageParts.join('\n');
      const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      
      const { data } = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId: originalMessage.threadId
        }
      });
      
      return formatResponse({
        success: true,
        messageId: data.id,
        threadId: data.threadId
      });
    });
  }
);

// Search emails
server.tool(
  'gmail_search_messages',
  'Search emails with advanced Gmail search operators',
  {
    query: z.string().describe('Gmail search query (supports operators like from:, to:, subject:, has:attachment, is:unread, after:, before:, etc.)'),
    maxResults: z.number().min(1).max(500).default(20).describe('Maximum number of results'),
    includeBody: z.boolean().default(false).describe('Include message body in results')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.list({
        userId: 'me',
        q: params.query,
        maxResults: params.maxResults
      });
      
      const messages = [];
      if (data.messages) {
        for (const msg of data.messages) {
          const format = params.includeBody ? 'full' : 'metadata';
          const { data: fullMessage } = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: format,
            metadataHeaders: ['From', 'To', 'Subject', 'Date']
          });
          
          const headers = extractHeaders(fullMessage.payload?.headers);
          const messageData = {
            id: fullMessage.id,
            threadId: fullMessage.threadId,
            from: headers.from,
            to: headers.to,
            subject: headers.subject,
            date: headers.date,
            snippet: fullMessage.snippet,
            labelIds: fullMessage.labelIds
          };
          
          if (params.includeBody) {
            messageData.body = decodeMessageBody(fullMessage);
          }
          
          messages.push(messageData);
        }
      }
      
      return formatResponse({
        messages,
        totalResults: data.resultSizeEstimate,
        query: params.query
      });
    });
  }
);

// Modify message labels
server.tool(
  'gmail_modify_labels',
  'Add or remove labels from a message',
  {
    messageId: z.string().describe('Message ID to modify'),
    addLabelIds: z.array(z.string()).optional().describe('Label IDs to add (e.g., ["IMPORTANT", "STARRED"])'),
    removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove (e.g., ["UNREAD", "INBOX"])')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.modify({
        userId: 'me',
        id: params.messageId,
        requestBody: {
          addLabelIds: params.addLabelIds,
          removeLabelIds: params.removeLabelIds
        }
      });
      
      return formatResponse({
        success: true,
        messageId: data.id,
        labelIds: data.labelIds,
        threadId: data.threadId
      });
    });
  }
);

// Trash a message
server.tool(
  'gmail_trash_message',
  'Move a message to trash',
  {
    messageId: z.string().describe('Message ID to trash')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.trash({
        userId: 'me',
        id: params.messageId
      });
      
      return formatResponse({
        success: true,
        messageId: data.id,
        labelIds: data.labelIds
      });
    });
  }
);

// Untrash a message
server.tool(
  'gmail_untrash_message',
  'Remove a message from trash',
  {
    messageId: z.string().describe('Message ID to untrash')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.untrash({
        userId: 'me',
        id: params.messageId
      });
      
      return formatResponse({
        success: true,
        messageId: data.id,
        labelIds: data.labelIds
      });
    });
  }
);

// Delete a message permanently
server.tool(
  'gmail_delete_message',
  'Permanently delete a message (cannot be undone)',
  {
    messageId: z.string().describe('Message ID to delete permanently')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      await gmail.users.messages.delete({
        userId: 'me',
        id: params.messageId
      });
      
      return formatResponse({
        success: true,
        message: `Message ${params.messageId} permanently deleted`
      });
    });
  }
);

// List labels
server.tool(
  'gmail_list_labels',
  'List all Gmail labels',
  {},
  async () => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.labels.list({
        userId: 'me'
      });
      
      return formatResponse({
        labels: data.labels?.map(label => ({
          id: label.id,
          name: label.name,
          type: label.type,
          messageListVisibility: label.messageListVisibility,
          labelListVisibility: label.labelListVisibility,
          messagesTotal: label.messagesTotal,
          messagesUnread: label.messagesUnread,
          threadsTotal: label.threadsTotal,
          threadsUnread: label.threadsUnread
        }))
      });
    });
  }
);

// Create a label
server.tool(
  'gmail_create_label',
  'Create a new Gmail label',
  {
    name: z.string().describe('Name of the label'),
    messageListVisibility: z.enum(['show', 'hide']).optional().describe('Show in message list'),
    labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe('Show in label list')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name: params.name,
          messageListVisibility: params.messageListVisibility,
          labelListVisibility: params.labelListVisibility
        }
      });
      
      return formatResponse({
        success: true,
        label: {
          id: data.id,
          name: data.name,
          type: data.type
        }
      });
    });
  }
);

// Delete a label
server.tool(
  'gmail_delete_label',
  'Delete a Gmail label',
  {
    labelId: z.string().describe('ID of the label to delete')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      await gmail.users.labels.delete({
        userId: 'me',
        id: params.labelId
      });
      
      return formatResponse({
        success: true,
        message: `Label ${params.labelId} deleted`
      });
    });
  }
);

// Get thread
server.tool(
  'gmail_get_thread',
  'Get all messages in a thread',
  {
    threadId: z.string().describe('Thread ID to retrieve'),
    format: z.enum(['full', 'metadata', 'minimal']).default('metadata').describe('Format for messages in thread')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.threads.get({
        userId: 'me',
        id: params.threadId,
        format: params.format
      });
      
      const messages = data.messages?.map(msg => {
        const headers = extractHeaders(msg.payload?.headers);
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: headers.from,
          to: headers.to,
          subject: headers.subject,
          date: headers.date,
          snippet: msg.snippet,
          labelIds: msg.labelIds,
          body: params.format === 'full' ? decodeMessageBody(msg) : undefined
        };
      });
      
      return formatResponse({
        id: data.id,
        historyId: data.historyId,
        messages: messages
      });
    });
  }
);

// Get user profile
server.tool(
  'gmail_get_profile',
  'Get Gmail user profile information',
  {},
  async () => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.getProfile({
        userId: 'me'
      });
      
      return formatResponse({
        emailAddress: data.emailAddress,
        messagesTotal: data.messagesTotal,
        threadsTotal: data.threadsTotal,
        historyId: data.historyId
      });
    });
  }
);

// Create draft
server.tool(
  'gmail_create_draft',
  'Create a draft email',
  {
    to: z.string().describe('Recipient email address(es)'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body'),
    cc: z.string().optional().describe('CC recipients'),
    bcc: z.string().optional().describe('BCC recipients'),
    isHtml: z.boolean().default(false).describe('Whether the body is HTML')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const messageParts = [
        `To: ${params.to}`,
        `Subject: ${params.subject}`
      ];
      
      if (params.cc) messageParts.push(`Cc: ${params.cc}`);
      if (params.bcc) messageParts.push(`Bcc: ${params.bcc}`);
      
      if (params.isHtml) {
        messageParts.push('Content-Type: text/html; charset=utf-8');
      } else {
        messageParts.push('Content-Type: text/plain; charset=utf-8');
      }
      
      messageParts.push('');
      messageParts.push(params.body);
      
      const message = messageParts.join('\n');
      const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      
      const { data } = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: encodedMessage
          }
        }
      });
      
      return formatResponse({
        success: true,
        draftId: data.id,
        messageId: data.message?.id
      });
    });
  }
);

// Archive email (add INBOX label removal)
server.tool(
  'gmail_archive_message',
  'Archive an email message by removing it from INBOX',
  {
    messageId: z.string().describe('Message ID to archive')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.modify({
        userId: 'me',
        id: params.messageId,
        requestBody: {
          removeLabelIds: ['INBOX']
        }
      });
      
      return formatResponse({
        success: true,
        messageId: data.id,
        labelIds: data.labelIds,
        message: 'Message archived successfully'
      });
    });
  }
);


// List attachments in a message
server.tool(
  'gmail_list_attachments',
  'List all attachments in an email message',
  {
    messageId: z.string().describe('Message ID to check for attachments')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.get({
        userId: 'me',
        id: params.messageId,
        format: 'full'
      });
      
      const attachments = [];
      
      const findAttachments = (parts) => {
        if (!parts) return;
        
        for (const part of parts) {
          if (part.filename && part.body?.attachmentId) {
            attachments.push({
              filename: part.filename,
              mimeType: part.mimeType,
              attachmentId: part.body.attachmentId,
              size: part.body.size
            });
          }
          if (part.parts) {
            findAttachments(part.parts);
          }
        }
      };
      
      if (data.payload?.parts) {
        findAttachments(data.payload.parts);
      } else if (data.payload?.body?.attachmentId && data.payload?.filename) {
        attachments.push({
          filename: data.payload.filename,
          mimeType: data.payload.mimeType,
          attachmentId: data.payload.body.attachmentId,
          size: data.payload.body.size
        });
      }
      
      return formatResponse({
        messageId: params.messageId,
        attachments: attachments,
        totalAttachments: attachments.length
      });
    });
  }
);

// Get signature
server.tool(
  'gmail_get_signature',
  'Get the email signature for the primary send-as alias',
  {},
  async () => {
    return handleGmailOperation(async (gmail) => {
      // First get the primary email address
      const { data: profile } = await gmail.users.getProfile({
        userId: 'me'
      });
      
      // Get the send-as settings for primary email
      const { data } = await gmail.users.settings.sendAs.get({
        userId: 'me',
        sendAsEmail: profile.emailAddress
      });
      
      return formatResponse({
        email: data.sendAsEmail,
        displayName: data.displayName,
        signature: data.signature,
        isDefault: data.isDefault,
        isPrimary: data.isPrimary,
        treatAsAlias: data.treatAsAlias
      });
    });
  }
);

// Update signature
server.tool(
  'gmail_update_signature',
  'Update the email signature for the primary send-as alias',
  {
    signature: z.string().describe('HTML signature content'),
    displayName: z.string().optional().describe('Display name for the sender')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      // First get the primary email address
      const { data: profile } = await gmail.users.getProfile({
        userId: 'me'
      });
      
      // Update the send-as settings
      const { data } = await gmail.users.settings.sendAs.update({
        userId: 'me',
        sendAsEmail: profile.emailAddress,
        requestBody: {
          signature: params.signature,
          displayName: params.displayName
        }
      });
      
      return formatResponse({
        success: true,
        email: data.sendAsEmail,
        signature: data.signature,
        displayName: data.displayName
      });
    });
  }
);

// List send-as aliases
server.tool(
  'gmail_list_send_as',
  'List all send-as aliases for the authenticated user',
  {},
  async () => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.settings.sendAs.list({
        userId: 'me'
      });
      
      return formatResponse({
        sendAsAliases: data.sendAs?.map(alias => ({
          sendAsEmail: alias.sendAsEmail,
          displayName: alias.displayName,
          replyToAddress: alias.replyToAddress,
          signature: alias.signature,
          isDefault: alias.isDefault,
          isPrimary: alias.isPrimary,
          treatAsAlias: alias.treatAsAlias,
          verificationStatus: alias.verificationStatus
        }))
      });
    });
  }
);

// Get specific send-as alias
server.tool(
  'gmail_get_send_as',
  'Get a specific send-as alias',
  {
    sendAsEmail: z.string().describe('Email address of the send-as alias')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.settings.sendAs.get({
        userId: 'me',
        sendAsEmail: params.sendAsEmail
      });
      
      return formatResponse({
        sendAsEmail: data.sendAsEmail,
        displayName: data.displayName,
        replyToAddress: data.replyToAddress,
        signature: data.signature,
        isDefault: data.isDefault,
        isPrimary: data.isPrimary,
        treatAsAlias: data.treatAsAlias,
        verificationStatus: data.verificationStatus,
        smtpMsa: data.smtpMsa
      });
    });
  }
);

// Batch delete messages
server.tool(
  'gmail_batch_delete',
  'Delete multiple messages at once',
  {
    messageIds: z.array(z.string()).describe('Array of message IDs to delete')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.batchDelete({
        userId: 'me',
        requestBody: {
          ids: params.messageIds
        }
      });
      
      return formatResponse({
        success: true,
        deletedCount: params.messageIds.length,
        message: `Successfully deleted ${params.messageIds.length} messages`
      });
    });
  }
);

// Batch modify messages
server.tool(
  'gmail_batch_modify',
  'Apply labels or other modifications to multiple messages',
  {
    messageIds: z.array(z.string()).describe('Array of message IDs to modify'),
    addLabelIds: z.array(z.string()).optional().describe('Labels to add'),
    removeLabelIds: z.array(z.string()).optional().describe('Labels to remove')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: params.messageIds,
          addLabelIds: params.addLabelIds,
          removeLabelIds: params.removeLabelIds
        }
      });
      
      return formatResponse({
        success: true,
        modifiedCount: params.messageIds.length,
        addedLabels: params.addLabelIds,
        removedLabels: params.removeLabelIds
      });
    });
  }
);

// Mark as read
server.tool(
  'gmail_mark_as_read',
  'Mark message(s) as read',
  {
    messageIds: z.array(z.string()).describe('Message ID(s) to mark as read')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: params.messageIds,
          removeLabelIds: ['UNREAD']
        }
      });
      
      return formatResponse({
        success: true,
        markedCount: params.messageIds.length,
        message: `Marked ${params.messageIds.length} message(s) as read`
      });
    });
  }
);

// Mark as unread
server.tool(
  'gmail_mark_as_unread',
  'Mark message(s) as unread',
  {
    messageIds: z.array(z.string()).describe('Message ID(s) to mark as unread')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: params.messageIds,
          addLabelIds: ['UNREAD']
        }
      });
      
      return formatResponse({
        success: true,
        markedCount: params.messageIds.length,
        message: `Marked ${params.messageIds.length} message(s) as unread`
      });
    });
  }
);

// Get filters
server.tool(
  'gmail_list_filters',
  'List all email filters',
  {},
  async () => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.settings.filters.list({
        userId: 'me'
      });
      
      return formatResponse({
        filters: data.filter?.map(filter => ({
          id: filter.id,
          criteria: filter.criteria,
          action: filter.action
        }))
      });
    });
  }
);

// Create filter
server.tool(
  'gmail_create_filter',
  'Create an email filter',
  {
    from: z.string().optional().describe('Filter emails from this sender'),
    to: z.string().optional().describe('Filter emails to this recipient'),
    subject: z.string().optional().describe('Filter by subject'),
    query: z.string().optional().describe('Gmail search query for filter'),
    hasAttachment: z.boolean().optional().describe('Filter emails with attachments'),
    addLabelIds: z.array(z.string()).optional().describe('Labels to add'),
    removeLabelIds: z.array(z.string()).optional().describe('Labels to remove'),
    forward: z.string().optional().describe('Forward to email address')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const criteria = {};
      if (params.from) criteria.from = params.from;
      if (params.to) criteria.to = params.to;
      if (params.subject) criteria.subject = params.subject;
      if (params.query) criteria.query = params.query;
      if (params.hasAttachment) criteria.hasAttachment = params.hasAttachment;
      
      const action = {};
      if (params.addLabelIds) action.addLabelIds = params.addLabelIds;
      if (params.removeLabelIds) action.removeLabelIds = params.removeLabelIds;
      if (params.forward) action.forward = params.forward;
      
      const { data } = await gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria,
          action
        }
      });
      
      return formatResponse({
        success: true,
        filterId: data.id,
        criteria: data.criteria,
        action: data.action
      });
    });
  }
);

// Mark as spam
server.tool(
  'gmail_mark_as_spam',
  'Mark message(s) as spam',
  {
    messageIds: z.array(z.string()).describe('Message ID(s) to mark as spam')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: params.messageIds,
          addLabelIds: ['SPAM'],
          removeLabelIds: ['INBOX']
        }
      });
      
      return formatResponse({
        success: true,
        markedCount: params.messageIds.length,
        message: `Marked ${params.messageIds.length} message(s) as spam`
      });
    });
  }
);

// Mark as not spam
server.tool(
  'gmail_mark_as_not_spam',
  'Remove message(s) from spam',
  {
    messageIds: z.array(z.string()).describe('Message ID(s) to unmark as spam')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: params.messageIds,
          removeLabelIds: ['SPAM'],
          addLabelIds: ['INBOX']
        }
      });
      
      return formatResponse({
        success: true,
        markedCount: params.messageIds.length,
        message: `Removed ${params.messageIds.length} message(s) from spam`
      });
    });
  }
);

// List spam messages
server.tool(
  'gmail_list_spam',
  'List messages in spam folder',
  {
    maxResults: z.number().min(1).max(500).default(20).describe('Maximum number of spam messages to return'),
    pageToken: z.string().optional().describe('Page token for pagination')
  },
  async (params) => {
    return handleGmailOperation(async (gmail) => {
      const { data } = await gmail.users.messages.list({
        userId: 'me',
        labelIds: ['SPAM'],
        maxResults: params.maxResults,
        pageToken: params.pageToken
      });
      
      const messages = [];
      if (data.messages) {
        for (const msg of data.messages.slice(0, params.maxResults)) {
          const { data: fullMessage } = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date']
          });
          
          const headers = extractHeaders(fullMessage.payload?.headers);
          messages.push({
            id: fullMessage.id,
            threadId: fullMessage.threadId,
            from: headers.from,
            to: headers.to,
            subject: headers.subject,
            date: headers.date,
            snippet: fullMessage.snippet
          });
        }
      }
      
      return formatResponse({
        messages,
        nextPageToken: data.nextPageToken,
        totalSpamMessages: data.resultSizeEstimate
      });
    });
  }
);

// Empty spam folder
server.tool(
  'gmail_empty_spam',
  'Permanently delete all messages in spam folder',
  {
    confirm: z.boolean().describe('Confirm deletion of all spam messages (required to be true)')
  },
  async (params) => {
    if (!params.confirm) {
      throw new Error('Confirmation required to empty spam folder');
    }
    
    return handleGmailOperation(async (gmail) => {
      // First get all spam messages
      const { data } = await gmail.users.messages.list({
        userId: 'me',
        labelIds: ['SPAM'],
        maxResults: 500
      });
      
      if (!data.messages || data.messages.length === 0) {
        return formatResponse({
          success: true,
          message: 'Spam folder is already empty'
        });
      }
      
      // Batch delete all spam messages
      const messageIds = data.messages.map(msg => msg.id);
      await gmail.users.messages.batchDelete({
        userId: 'me',
        requestBody: {
          ids: messageIds
        }
      });
      
      return formatResponse({
        success: true,
        deletedCount: messageIds.length,
        message: `Permanently deleted ${messageIds.length} spam messages`
      });
    });
  }
);

// Empty trash folder
server.tool(
  'gmail_empty_trash',
  'Permanently delete all messages in trash folder',
  {
    confirm: z.boolean().describe('Confirm deletion of all trash messages (required to be true)')
  },
  async (params) => {
    if (!params.confirm) {
      throw new Error('Confirmation required to empty trash folder');
    }
    
    return handleGmailOperation(async (gmail) => {
      // First get all trash messages
      const { data } = await gmail.users.messages.list({
        userId: 'me',
        labelIds: ['TRASH'],
        maxResults: 500
      });
      
      if (!data.messages || data.messages.length === 0) {
        return formatResponse({
          success: true,
          message: 'Trash folder is already empty'
        });
      }
      
      // Batch delete all trash messages
      const messageIds = data.messages.map(msg => msg.id);
      await gmail.users.messages.batchDelete({
        userId: 'me',
        requestBody: {
          ids: messageIds
        }
      });
      
      return formatResponse({
        success: true,
        deletedCount: messageIds.length,
        message: `Permanently deleted ${messageIds.length} trash messages`
      });
    });
  }
);

// Start the server
async function main() {
  console.error('[Gmail MCP] Server starting...');
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Gmail MCP] Server running on stdio transport');
}

main().catch((error) => {
  console.error('[Gmail MCP] Fatal error:', error);
  process.exit(1);
});