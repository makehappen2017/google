#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { createAuthClient } from '../shared/auth.js';

// Google Drive API scopes
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly'
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
  
  console.error('[Google Drive MCP] OAuth check:', {
    hasAccessToken: !!accessToken,
    hasRefreshToken: !!refreshToken,
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret
  });
  
  if (!refreshToken && !accessToken) {
    console.error('[Google Drive MCP] ERROR: No OAuth tokens found');
    throw new Error('OAuth tokens not provided. Please authenticate with Google.');
  }

  return createAuthClient({
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });
};

// Initialize Drive client
const getDriveClient = () => {
  try {
    const auth = getOAuth2Client();
    return google.drive({ version: 'v3', auth });
  } catch (error) {
    console.error('Failed to initialize Drive client:', error.message);
    return null;
  }
};

// Create MCP server
const server = new McpServer({
  name: 'google-drive',
  version: '1.0.0'
});

// Helper function to format responses
const formatResponse = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
});

// Helper function to handle Drive operations
const handleDriveOperation = async (operation) => {
  try {
    const drive = getDriveClient();
    if (!drive) {
      throw new Error('Drive client not initialized. Please check OAuth credentials.');
    }
    return await operation(drive);
  } catch (error) {
    console.error('Drive operation failed:', error);
    throw error;
  }
};

// Tool: List files
server.tool(
  'list_files',
  'List files in Google Drive',
  {
    query: z.string().optional().describe('Search query'),
    pageSize: z.number().optional().default(10).describe('Number of files to return'),
    orderBy: z.string().optional().default('modifiedTime desc').describe('Sort order'),
    mimeType: z.string().optional().describe('Filter by MIME type'),
    folder: z.string().optional().describe('Folder ID to list files from')
  },
  async ({ query, pageSize, orderBy, mimeType, folder }) => {
    return handleDriveOperation(async (drive) => {
      const q = [];
      if (query) q.push(`name contains '${query}'`);
      if (mimeType) q.push(`mimeType = '${mimeType}'`);
      if (folder) q.push(`'${folder}' in parents`);
      q.push('trashed = false');

      const response = await drive.files.list({
        q: q.join(' and '),
        pageSize,
        orderBy,
        fields: 'files(id, name, mimeType, size, modifiedTime, createdTime, parents, webViewLink, webContentLink, thumbnailLink)'
      });

      return formatResponse({
        files: response.data.files,
        count: response.data.files?.length || 0
      });
    });
  }
);

// Tool: Get file details
server.tool(
  'get_file',
  'Get detailed information about a file',
  {
    fileId: z.string().describe('File ID')
  },
  async ({ fileId }) => {
    return handleDriveOperation(async (drive) => {
      const response = await drive.files.get({
        fileId,
        fields: '*'
      });

      return formatResponse(response.data);
    });
  }
);

// Tool: Download file content
server.tool(
  'download_file',
  'Download file content',
  {
    fileId: z.string().describe('File ID'),
    format: z.enum(['text', 'binary', 'base64']).optional().default('text').describe('Download format'),
    exportFormat: z.string().optional().describe('Export format for Google Docs (pdf, docx, xlsx, pptx, etc.)')
  },
  async ({ fileId, format, exportFormat }) => {
    return handleDriveOperation(async (drive) => {
      // First get file metadata
      const metaResponse = await drive.files.get({
        fileId,
        fields: 'name, mimeType, size'
      });

      const mimeType = metaResponse.data.mimeType;
      const fileName = metaResponse.data.name;
      
      // Handle Google Docs exports
      if (mimeType?.startsWith('application/vnd.google-apps.')) {
        let exportMimeType = exportFormat || 'text/plain';
        
        // Default export formats if not specified
        if (!exportFormat) {
          if (mimeType.includes('document')) exportMimeType = 'text/plain';
          else if (mimeType.includes('spreadsheet')) exportMimeType = 'text/csv';
          else if (mimeType.includes('presentation')) exportMimeType = 'text/plain';
          else if (mimeType.includes('drawing')) exportMimeType = 'image/png';
        } else {
          // Map common format names to MIME types
          const formatMap = {
            'pdf': 'application/pdf',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'txt': 'text/plain',
            'html': 'text/html',
            'rtf': 'application/rtf',
            'odt': 'application/vnd.oasis.opendocument.text',
            'ods': 'application/vnd.oasis.opendocument.spreadsheet',
            'csv': 'text/csv',
            'tsv': 'text/tab-separated-values',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'svg': 'image/svg+xml'
          };
          exportMimeType = formatMap[exportFormat.toLowerCase()] || exportFormat;
        }
        
        const responseType = format === 'binary' || format === 'base64' ? 'arraybuffer' : 'text';
        const response = await drive.files.export({
          fileId,
          mimeType: exportMimeType
        }, { responseType });
        
        let content = response.data;
        if (format === 'base64' && responseType === 'arraybuffer') {
          content = Buffer.from(response.data).toString('base64');
        }
        
        return formatResponse({
          name: fileName,
          content,
          mimeType: exportMimeType,
          format,
          size: metaResponse.data.size
        });
      } else {
        // Download regular files
        const responseType = format === 'binary' || format === 'base64' ? 'arraybuffer' : 'text';
        const response = await drive.files.get({
          fileId,
          alt: 'media'
        }, { responseType });
        
        let content = response.data;
        if (format === 'base64' && responseType === 'arraybuffer') {
          content = Buffer.from(response.data).toString('base64');
        }
        
        return formatResponse({
          name: fileName,
          content,
          mimeType,
          format,
          size: metaResponse.data.size
        });
      }
    });
  }
);

// Tool: Create file
server.tool(
  'create_file',
  'Create a new file in Google Drive',
  {
    name: z.string().describe('File name'),
    content: z.string().optional().describe('File content'),
    mimeType: z.string().optional().default('text/plain').describe('MIME type'),
    parents: z.array(z.string()).optional().describe('Parent folder IDs')
  },
  async ({ name, content, mimeType, parents }) => {
    return handleDriveOperation(async (drive) => {
      const fileMetadata = {
        name,
        mimeType,
        parents
      };

      const media = content ? {
        mimeType,
        body: content
      } : undefined;

      const response = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id, name, webViewLink, webContentLink'
      });

      return formatResponse({
        message: 'File created successfully',
        file: response.data
      });
    });
  }
);

// Tool: Update file
server.tool(
  'update_file',
  'Update an existing file',
  {
    fileId: z.string().describe('File ID'),
    name: z.string().optional().describe('New file name'),
    content: z.string().optional().describe('New file content'),
    addParents: z.array(z.string()).optional().describe('Folder IDs to add as parents'),
    removeParents: z.array(z.string()).optional().describe('Folder IDs to remove as parents')
  },
  async ({ fileId, name, content, addParents, removeParents }) => {
    return handleDriveOperation(async (drive) => {
      const updateData = {};
      if (name) updateData.name = name;

      const media = content ? {
        mimeType: 'text/plain',
        body: content
      } : undefined;

      const response = await drive.files.update({
        fileId,
        requestBody: updateData,
        media,
        addParents: addParents?.join(','),
        removeParents: removeParents?.join(','),
        fields: 'id, name, modifiedTime'
      });

      return formatResponse({
        message: 'File updated successfully',
        file: response.data
      });
    });
  }
);

// Tool: Delete file (permanent)
server.tool(
  'delete_file',
  'Permanently delete a file or folder without moving it to the trash',
  {
    fileId: z.string().describe('File ID')
  },
  async ({ fileId }) => {
    return handleDriveOperation(async (drive) => {
      await drive.files.delete({ fileId });
      
      return formatResponse({
        message: 'File permanently deleted',
        fileId
      });
    });
  }
);

// Tool: Move file to trash
server.tool(
  'move_to_trash',
  'Move a file or folder to trash',
  {
    fileId: z.string().describe('File ID')
  },
  async ({ fileId }) => {
    return handleDriveOperation(async (drive) => {
      const response = await drive.files.update({
        fileId,
        requestBody: {
          trashed: true
        },
        fields: 'id, name, trashed'
      });
      
      return formatResponse({
        message: 'File moved to trash',
        file: response.data
      });
    });
  }
);

// Tool: Move file
server.tool(
  'move_file',
  'Move a file from one folder to another',
  {
    fileId: z.string().describe('File ID'),
    newParentId: z.string().describe('New parent folder ID'),
    removeFromCurrentParents: z.boolean().optional().default(true).describe('Remove from current parents')
  },
  async ({ fileId, newParentId, removeFromCurrentParents }) => {
    return handleDriveOperation(async (drive) => {
      // Get current parents if we need to remove from them
      let previousParents = '';
      if (removeFromCurrentParents) {
        const file = await drive.files.get({
          fileId,
          fields: 'parents'
        });
        previousParents = file.data.parents ? file.data.parents.join(',') : '';
      }

      const response = await drive.files.update({
        fileId,
        addParents: newParentId,
        removeParents: removeFromCurrentParents ? previousParents : undefined,
        fields: 'id, name, parents'
      });
      
      return formatResponse({
        message: 'File moved successfully',
        file: response.data
      });
    });
  }
);

// Tool: Copy file
server.tool(
  'copy_file',
  'Create a copy of the specified file',
  {
    fileId: z.string().describe('File ID to copy'),
    name: z.string().optional().describe('Name for the copy'),
    parents: z.array(z.string()).optional().describe('Parent folder IDs for the copy')
  },
  async ({ fileId, name, parents }) => {
    return handleDriveOperation(async (drive) => {
      const requestBody = {};
      if (name) requestBody.name = name;
      if (parents) requestBody.parents = parents;

      const response = await drive.files.copy({
        fileId,
        requestBody,
        fields: 'id, name, webViewLink, parents'
      });
      
      return formatResponse({
        message: 'File copied successfully',
        file: response.data
      });
    });
  }
);

// Tool: Create folder
server.tool(
  'create_folder',
  'Create a new folder in Google Drive',
  {
    name: z.string().describe('Folder name'),
    parents: z.array(z.string()).optional().describe('Parent folder IDs')
  },
  async ({ name, parents }) => {
    return handleDriveOperation(async (drive) => {
      const fileMetadata = {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents
      };

      const response = await drive.files.create({
        requestBody: fileMetadata,
        fields: 'id, name, webViewLink'
      });

      return formatResponse({
        message: 'Folder created successfully',
        folder: response.data
      });
    });
  }
);

// Tool: Share file
server.tool(
  'share_file',
  'Share a file with specific users or make it public',
  {
    fileId: z.string().describe('File ID'),
    email: z.string().optional().describe('Email address to share with'),
    role: z.enum(['reader', 'writer', 'commenter']).default('reader').describe('Permission role'),
    type: z.enum(['user', 'anyone', 'domain']).default('user').describe('Permission type'),
    sendNotification: z.boolean().optional().default(true).describe('Send notification email')
  },
  async ({ fileId, email, role, type, sendNotification }) => {
    return handleDriveOperation(async (drive) => {
      const permission = {
        type,
        role
      };
      
      if (type === 'user' && email) {
        permission.emailAddress = email;
      }

      const response = await drive.permissions.create({
        fileId,
        requestBody: permission,
        sendNotificationEmail: sendNotification,
        fields: 'id, type, role, emailAddress'
      });

      return formatResponse({
        message: 'File shared successfully',
        permission: response.data
      });
    });
  }
);

// Tool: Search files
server.tool(
  'search_files',
  'Search for files in Google Drive',
  {
    query: z.string().describe('Search query'),
    mimeType: z.string().optional().describe('Filter by MIME type'),
    modifiedAfter: z.string().optional().describe('ISO date string for modified time filter'),
    owner: z.string().optional().describe('Filter by owner email'),
    sharedWithMe: z.boolean().optional().describe('Only show files shared with me')
  },
  async ({ query, mimeType, modifiedAfter, owner, sharedWithMe }) => {
    return handleDriveOperation(async (drive) => {
      const q = [];
      
      if (query) {
        q.push(`(name contains '${query}' or fullText contains '${query}')`);
      }
      if (mimeType) q.push(`mimeType = '${mimeType}'`);
      if (modifiedAfter) q.push(`modifiedTime > '${modifiedAfter}'`);
      if (owner) q.push(`'${owner}' in owners`);
      if (sharedWithMe) q.push('sharedWithMe = true');
      q.push('trashed = false');

      const response = await drive.files.list({
        q: q.join(' and '),
        pageSize: 20,
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, mimeType, size, modifiedTime, owners, webViewLink)'
      });

      return formatResponse({
        files: response.data.files,
        count: response.data.files?.length || 0,
        query: q.join(' and ')
      });
    });
  }
);

// Tool: Get storage quota
server.tool(
  'get_storage_quota',
  'Get Google Drive storage quota information',
  {},
  async () => {
    return handleDriveOperation(async (drive) => {
      const response = await drive.about.get({
        fields: 'storageQuota, user'
      });

      const quota = response.data.storageQuota;
      const usedGB = (parseInt(quota?.usage || 0) / 1024 / 1024 / 1024).toFixed(2);
      const limitGB = quota?.limit ? (parseInt(quota.limit) / 1024 / 1024 / 1024).toFixed(2) : 'Unlimited';
      
      return formatResponse({
        user: response.data.user,
        storage: {
          used: `${usedGB} GB`,
          limit: `${limitGB} GB`,
          usageInDrive: quota?.usageInDrive,
          usageInDriveTrash: quota?.usageInDriveTrash
        }
      });
    });
  }
);

// Tool: Upload file
server.tool(
  'upload_file',
  'Upload a file to Google Drive',
  {
    name: z.string().describe('File name'),
    content: z.string().describe('File content or base64 encoded data'),
    mimeType: z.string().optional().default('text/plain').describe('MIME type'),
    parents: z.array(z.string()).optional().describe('Parent folder IDs'),
    description: z.string().optional().describe('File description')
  },
  async ({ name, content, mimeType, parents, description }) => {
    return handleDriveOperation(async (drive) => {
      const fileMetadata = {
        name,
        mimeType,
        parents,
        description
      };

      const media = {
        mimeType,
        body: content
      };

      const response = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id, name, webViewLink, webContentLink, size'
      });

      return formatResponse({
        message: 'File uploaded successfully',
        file: response.data
      });
    });
  }
);

// Tool: Find file by name
server.tool(
  'find_file',
  'Search for a specific file by name',
  {
    name: z.string().describe('File name to search for'),
    exact: z.boolean().optional().default(false).describe('Exact name match'),
    mimeType: z.string().optional().describe('Filter by MIME type')
  },
  async ({ name, exact, mimeType }) => {
    return handleDriveOperation(async (drive) => {
      const q = [];
      if (exact) {
        q.push(`name = '${name}'`);
      } else {
        q.push(`name contains '${name}'`);
      }
      if (mimeType) q.push(`mimeType = '${mimeType}'`);
      q.push('trashed = false');

      const response = await drive.files.list({
        q: q.join(' and '),
        pageSize: 10,
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)'
      });

      return formatResponse({
        files: response.data.files,
        count: response.data.files?.length || 0
      });
    });
  }
);

// Tool: Find folder
server.tool(
  'find_folder',
  'Search for a specific folder by name',
  {
    name: z.string().describe('Folder name to search for'),
    exact: z.boolean().optional().default(false).describe('Exact name match'),
    parent: z.string().optional().describe('Parent folder ID')
  },
  async ({ name, exact, parent }) => {
    return handleDriveOperation(async (drive) => {
      const q = [];
      if (exact) {
        q.push(`name = '${name}'`);
      } else {
        q.push(`name contains '${name}'`);
      }
      q.push(`mimeType = 'application/vnd.google-apps.folder'`);
      if (parent) q.push(`'${parent}' in parents`);
      q.push('trashed = false');

      const response = await drive.files.list({
        q: q.join(' and '),
        pageSize: 10,
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, modifiedTime, webViewLink, parents)'
      });

      return formatResponse({
        folders: response.data.files,
        count: response.data.files?.length || 0
      });
    });
  }
);

// Tool: Find spreadsheets
server.tool(
  'find_spreadsheets',
  'Search for a specific spreadsheet by name',
  {
    name: z.string().optional().describe('Spreadsheet name to search for'),
    exact: z.boolean().optional().default(false).describe('Exact name match')
  },
  async ({ name, exact }) => {
    return handleDriveOperation(async (drive) => {
      const q = [];
      if (name) {
        if (exact) {
          q.push(`name = '${name}'`);
        } else {
          q.push(`name contains '${name}'`);
        }
      }
      q.push(`mimeType = 'application/vnd.google-apps.spreadsheet'`);
      q.push('trashed = false');

      const response = await drive.files.list({
        q: q.join(' and '),
        pageSize: 20,
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, modifiedTime, webViewLink, createdTime)'
      });

      return formatResponse({
        spreadsheets: response.data.files,
        count: response.data.files?.length || 0
      });
    });
  }
);

// Tool: Find forms
server.tool(
  'find_forms',
  'List Google Form documents or search for a Form by name',
  {
    name: z.string().optional().describe('Form name to search for'),
    exact: z.boolean().optional().default(false).describe('Exact name match')
  },
  async ({ name, exact }) => {
    return handleDriveOperation(async (drive) => {
      const q = [];
      if (name) {
        if (exact) {
          q.push(`name = '${name}'`);
        } else {
          q.push(`name contains '${name}'`);
        }
      }
      q.push(`mimeType = 'application/vnd.google-apps.form'`);
      q.push('trashed = false');

      const response = await drive.files.list({
        q: q.join(' and '),
        pageSize: 20,
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, modifiedTime, webViewLink, createdTime)'
      });

      return formatResponse({
        forms: response.data.files,
        count: response.data.files?.length || 0
      });
    });
  }
);

// Tool: Get folder ID for path
server.tool(
  'get_folder_id_for_path',
  'Retrieve a folderId for a path',
  {
    path: z.string().describe('Path like /folder1/folder2/folder3'),
    createIfNotExists: z.boolean().optional().default(false).describe('Create folders if they do not exist')
  },
  async ({ path, createIfNotExists }) => {
    return handleDriveOperation(async (drive) => {
      const folders = path.split('/').filter(f => f);
      let currentParentId = 'root';
      
      for (const folderName of folders) {
        // Search for folder in current parent
        const response = await drive.files.list({
          q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and '${currentParentId}' in parents and trashed = false`,
          fields: 'files(id, name)',
          pageSize: 1
        });

        if (response.data.files && response.data.files.length > 0) {
          currentParentId = response.data.files[0].id;
        } else if (createIfNotExists) {
          // Create the folder
          const createResponse = await drive.files.create({
            requestBody: {
              name: folderName,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [currentParentId]
            },
            fields: 'id'
          });
          currentParentId = createResponse.data.id;
        } else {
          throw new Error(`Folder not found: ${folderName} in path ${path}`);
        }
      }

      return formatResponse({
        path,
        folderId: currentParentId
      });
    });
  }
);

// Tool: Create file from template
server.tool(
  'create_file_from_template',
  'Create a new Google Docs file from a template with placeholder replacement',
  {
    templateId: z.string().describe('Template file ID'),
    name: z.string().describe('Name for the new file'),
    parents: z.array(z.string()).optional().describe('Parent folder IDs'),
    placeholders: z.record(z.string()).optional().describe('Key-value pairs for placeholder replacement')
  },
  async ({ templateId, name, parents, placeholders }) => {
    return handleDriveOperation(async (drive) => {
      // First, copy the template
      const copyResponse = await drive.files.copy({
        fileId: templateId,
        requestBody: {
          name,
          parents
        },
        fields: 'id, name, webViewLink, mimeType'
      });

      const newFileId = copyResponse.data.id;
      const mimeType = copyResponse.data.mimeType;

      // If placeholders provided and it's a Google Doc, replace them
      if (placeholders && Object.keys(placeholders).length > 0) {
        if (mimeType === 'application/vnd.google-apps.document') {
          // Note: This would require Google Docs API for full implementation
          // For now, we'll return the file with a note about placeholders
          return formatResponse({
            message: 'File created from template (placeholder replacement requires Google Docs API)',
            file: copyResponse.data,
            placeholders
          });
        }
      }

      return formatResponse({
        message: 'File created from template successfully',
        file: copyResponse.data
      });
    });
  }
);

// Tool: Create file from text
server.tool(
  'create_file_from_text',
  'Create a new file from plain text',
  {
    name: z.string().describe('File name'),
    content: z.string().describe('Text content'),
    parents: z.array(z.string()).optional().describe('Parent folder IDs'),
    mimeType: z.string().optional().default('text/plain').describe('MIME type for the file')
  },
  async ({ name, content, parents, mimeType }) => {
    return handleDriveOperation(async (drive) => {
      const response = await drive.files.create({
        requestBody: {
          name,
          parents,
          mimeType
        },
        media: {
          mimeType,
          body: content
        },
        fields: 'id, name, webViewLink, webContentLink, size'
      });

      return formatResponse({
        message: 'File created from text successfully',
        file: response.data
      });
    });
  }
);

// Tool: Get file by ID
server.tool(
  'get_file_by_id',
  'Get info on a specific file',
  {
    fileId: z.string().describe('File ID'),
    fields: z.string().optional().describe('Specific fields to retrieve')
  },
  async ({ fileId, fields }) => {
    return handleDriveOperation(async (drive) => {
      const response = await drive.files.get({
        fileId,
        fields: fields || '*'
      });

      return formatResponse(response.data);
    });
  }
);

// Tool: Share file or folder
server.tool(
  'share_file_or_folder',
  'Add a sharing permission to the sharing preferences of a file or folder and provide a sharing URL',
  {
    fileId: z.string().describe('File or folder ID'),
    email: z.string().optional().describe('Email address to share with (required for user type)'),
    role: z.enum(['reader', 'writer', 'commenter', 'owner']).default('reader').describe('Permission role'),
    type: z.enum(['user', 'anyone', 'domain', 'group']).default('user').describe('Permission type'),
    domain: z.string().optional().describe('Domain for domain type sharing'),
    sendNotification: z.boolean().optional().default(true).describe('Send notification email'),
    emailMessage: z.string().optional().describe('Message to include in notification email'),
    allowFileDiscovery: z.boolean().optional().default(false).describe('For anyone type, allow file discovery')
  },
  async ({ fileId, email, role, type, domain, sendNotification, emailMessage, allowFileDiscovery }) => {
    return handleDriveOperation(async (drive) => {
      const permission = {
        type,
        role
      };
      
      if (type === 'user' && email) {
        permission.emailAddress = email;
      } else if (type === 'domain' && domain) {
        permission.domain = domain;
      } else if (type === 'group' && email) {
        permission.emailAddress = email;
      } else if (type === 'anyone') {
        permission.allowFileDiscovery = allowFileDiscovery;
      }

      const response = await drive.permissions.create({
        fileId,
        requestBody: permission,
        sendNotificationEmail: sendNotification,
        emailMessage,
        fields: 'id, type, role, emailAddress, domain'
      });

      // Get the sharing link
      const fileResponse = await drive.files.get({
        fileId,
        fields: 'webViewLink, webContentLink, name'
      });

      return formatResponse({
        message: 'File shared successfully',
        permission: response.data,
        sharingUrl: fileResponse.data.webViewLink,
        downloadUrl: fileResponse.data.webContentLink,
        fileName: fileResponse.data.name
      });
    });
  }
);

// Tool: Create shared drive
server.tool(
  'create_shared_drive',
  'Create a new shared drive',
  {
    name: z.string().describe('Name of the shared drive'),
    hidden: z.boolean().optional().default(false).describe('Whether the shared drive is hidden from default view')
  },
  async ({ name, hidden }) => {
    return handleDriveOperation(async (drive) => {
      const requestId = Date.now().toString(); // Generate unique request ID
      
      const response = await drive.drives.create({
        requestId,
        requestBody: {
          name,
          hidden
        },
        fields: 'id, name, colorRgb, backgroundImageLink'
      });

      return formatResponse({
        message: 'Shared drive created successfully',
        drive: response.data
      });
    });
  }
);

// Tool: Update shared drive
server.tool(
  'update_shared_drive',
  'Update an existing shared drive',
  {
    driveId: z.string().describe('Shared drive ID'),
    name: z.string().optional().describe('New name for the shared drive'),
    hidden: z.boolean().optional().describe('Whether the shared drive is hidden'),
    restrictions: z.object({
      adminManagedRestrictions: z.boolean().optional(),
      copyRequiresWriterPermission: z.boolean().optional(),
      domainUsersOnly: z.boolean().optional(),
      driveMembersOnly: z.boolean().optional()
    }).optional().describe('Drive restrictions')
  },
  async ({ driveId, name, hidden, restrictions }) => {
    return handleDriveOperation(async (drive) => {
      const requestBody = {};
      if (name !== undefined) requestBody.name = name;
      if (hidden !== undefined) requestBody.hidden = hidden;
      if (restrictions) requestBody.restrictions = restrictions;

      const response = await drive.drives.update({
        driveId,
        requestBody,
        fields: 'id, name, hidden, restrictions'
      });

      return formatResponse({
        message: 'Shared drive updated successfully',
        drive: response.data
      });
    });
  }
);

// Tool: Delete shared drive
server.tool(
  'delete_shared_drive',
  'Delete a shared drive without any content',
  {
    driveId: z.string().describe('Shared drive ID'),
    allowItemDeletion: z.boolean().optional().default(false).describe('Delete even if drive contains items')
  },
  async ({ driveId, allowItemDeletion }) => {
    return handleDriveOperation(async (drive) => {
      if (!allowItemDeletion) {
        // Check if drive is empty
        const listResponse = await drive.files.list({
          q: `'${driveId}' in parents and trashed = false`,
          pageSize: 1,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });

        if (listResponse.data.files && listResponse.data.files.length > 0) {
          throw new Error('Shared drive is not empty. Set allowItemDeletion to true to delete with content.');
        }
      }

      await drive.drives.delete({ driveId });

      return formatResponse({
        message: 'Shared drive deleted successfully',
        driveId
      });
    });
  }
);

// Tool: Get shared drive
server.tool(
  'get_shared_drive',
  'Get metadata for one or all shared drives',
  {
    driveId: z.string().optional().describe('Specific drive ID, or omit for all drives'),
    pageSize: z.number().optional().default(10).describe('Number of drives to return when listing all')
  },
  async ({ driveId, pageSize }) => {
    return handleDriveOperation(async (drive) => {
      if (driveId) {
        // Get specific drive
        const response = await drive.drives.get({
          driveId,
          fields: '*'
        });

        return formatResponse({
          drive: response.data
        });
      } else {
        // List all drives
        const response = await drive.drives.list({
          pageSize,
          fields: 'drives(id, name, colorRgb, backgroundImageLink, hidden, createdTime)'
        });

        return formatResponse({
          drives: response.data.drives,
          count: response.data.drives?.length || 0
        });
      }
    });
  }
);

// Tool: Search for shared drives
server.tool(
  'search_shared_drives',
  'Search for shared drives with query options',
  {
    query: z.string().optional().describe('Search query for drive name'),
    hidden: z.boolean().optional().describe('Filter by hidden status'),
    pageSize: z.number().optional().default(10).describe('Number of results to return')
  },
  async ({ query, hidden, pageSize }) => {
    return handleDriveOperation(async (drive) => {
      const q = [];
      if (query) q.push(`name contains '${query}'`);
      if (hidden !== undefined) q.push(`hidden = ${hidden}`);

      const response = await drive.drives.list({
        q: q.length > 0 ? q.join(' and ') : undefined,
        pageSize,
        fields: 'drives(id, name, colorRgb, hidden, createdTime)'
      });

      return formatResponse({
        drives: response.data.drives,
        count: response.data.drives?.length || 0
      });
    });
  }
);

// Tool: List folder contents recursively
server.tool(
  'list_folder_recursive',
  'List all files and subfolders recursively from a folder',
  {
    folderId: z.string().optional().default('root').describe('Folder ID to start from (default: root)'),
    maxDepth: z.number().optional().default(5).describe('Maximum depth to traverse'),
    includeFiles: z.boolean().optional().default(true).describe('Include files in results'),
    includeFolders: z.boolean().optional().default(true).describe('Include folders in results'),
    mimeType: z.string().optional().describe('Filter by MIME type')
  },
  async ({ folderId, maxDepth, includeFiles, includeFolders, mimeType }) => {
    return handleDriveOperation(async (drive) => {
      const allItems = [];
      const visited = new Set();
      
      async function traverseFolder(parentId, depth = 0, path = '') {
        if (depth >= maxDepth || visited.has(parentId)) return;
        visited.add(parentId);
        
        const q = [`'${parentId}' in parents`, 'trashed = false'];
        if (!includeFiles) q.push(`mimeType = 'application/vnd.google-apps.folder'`);
        if (!includeFolders && includeFiles) q.push(`mimeType != 'application/vnd.google-apps.folder'`);
        if (mimeType && includeFiles) q.push(`mimeType = '${mimeType}'`);
        
        try {
          const response = await drive.files.list({
            q: q.join(' and '),
            fields: 'files(id, name, mimeType, size, modifiedTime, parents)',
            pageSize: 100
          });
          
          for (const file of response.data.files || []) {
            const item = {
              ...file,
              path: path ? `${path}/${file.name}` : file.name,
              depth
            };
            allItems.push(item);
            
            // Recursively traverse subfolders
            if (file.mimeType === 'application/vnd.google-apps.folder') {
              await traverseFolder(file.id, depth + 1, item.path);
            }
          }
        } catch (error) {
          console.error(`Error traversing folder ${parentId}:`, error);
        }
      }
      
      await traverseFolder(folderId);
      
      return formatResponse({
        items: allItems,
        count: allItems.length,
        folderId,
        maxDepth
      });
    });
  }
);

// Tool: Get folder tree structure
server.tool(
  'get_folder_tree',
  'Get a tree structure of folders and files',
  {
    folderId: z.string().optional().default('root').describe('Root folder ID'),
    maxDepth: z.number().optional().default(3).describe('Maximum depth'),
    includeFiles: z.boolean().optional().default(false).describe('Include files in tree')
  },
  async ({ folderId, maxDepth, includeFiles }) => {
    return handleDriveOperation(async (drive) => {
      async function buildTree(parentId, depth = 0) {
        if (depth >= maxDepth) return null;
        
        const q = [`'${parentId}' in parents`, 'trashed = false'];
        if (!includeFiles) q.push(`mimeType = 'application/vnd.google-apps.folder'`);
        
        const response = await drive.files.list({
          q: q.join(' and '),
          fields: 'files(id, name, mimeType, size)',
          pageSize: 50,
          orderBy: 'name'
        });
        
        const items = [];
        for (const file of response.data.files || []) {
          const item = {
            id: file.id,
            name: file.name,
            type: file.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
            size: file.size
          };
          
          if (item.type === 'folder') {
            const children = await buildTree(file.id, depth + 1);
            if (children && children.length > 0) {
              item.children = children;
            }
          }
          
          items.push(item);
        }
        
        return items;
      }
      
      // Get root folder name if not 'root'
      let rootName = 'My Drive';
      if (folderId !== 'root') {
        const rootFile = await drive.files.get({
          fileId: folderId,
          fields: 'name'
        });
        rootName = rootFile.data.name;
      }
      
      const tree = await buildTree(folderId);
      
      return formatResponse({
        root: {
          id: folderId,
          name: rootName,
          children: tree
        }
      });
    });
  }
);

// Tool: Export file to format
server.tool(
  'export_file',
  'Export a Google Workspace file to a specific format',
  {
    fileId: z.string().describe('File ID'),
    format: z.enum(['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'html', 'rtf', 'odt', 'ods', 'csv', 'tsv', 'jpeg', 'png', 'svg']).describe('Export format'),
    returnAs: z.enum(['url', 'base64', 'content']).optional().default('content').describe('How to return the exported file')
  },
  async ({ fileId, format, returnAs }) => {
    return handleDriveOperation(async (drive) => {
      // Get file metadata
      const metaResponse = await drive.files.get({
        fileId,
        fields: 'name, mimeType'
      });
      
      const fileName = metaResponse.data.name;
      const mimeType = metaResponse.data.mimeType;
      
      if (!mimeType?.startsWith('application/vnd.google-apps.')) {
        throw new Error('Export is only available for Google Workspace files (Docs, Sheets, Slides, etc.)');
      }
      
      // Map format to MIME type
      const formatMap = {
        'pdf': 'application/pdf',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'txt': 'text/plain',
        'html': 'text/html',
        'rtf': 'application/rtf',
        'odt': 'application/vnd.oasis.opendocument.text',
        'ods': 'application/vnd.oasis.opendocument.spreadsheet',
        'csv': 'text/csv',
        'tsv': 'text/tab-separated-values',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'svg': 'image/svg+xml'
      };
      
      const exportMimeType = formatMap[format];
      
      if (returnAs === 'url') {
        // Generate export URL
        const exportUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
        
        return formatResponse({
          name: fileName,
          format,
          exportUrl,
          mimeType: exportMimeType
        });
      } else {
        // Download the exported content
        const responseType = returnAs === 'base64' ? 'arraybuffer' : 'text';
        const response = await drive.files.export({
          fileId,
          mimeType: exportMimeType
        }, { responseType });
        
        let content = response.data;
        if (returnAs === 'base64' && responseType === 'arraybuffer') {
          content = Buffer.from(response.data).toString('base64');
        }
        
        return formatResponse({
          name: fileName,
          format,
          content,
          mimeType: exportMimeType,
          returnAs
        });
      }
    });
  }
);

// Tool: Batch download files
server.tool(
  'batch_download',
  'Download multiple files at once',
  {
    fileIds: z.array(z.string()).describe('Array of file IDs to download'),
    format: z.enum(['text', 'base64']).optional().default('text').describe('Download format'),
    exportFormat: z.string().optional().describe('Export format for Google Docs')
  },
  async ({ fileIds, format, exportFormat }) => {
    return handleDriveOperation(async (drive) => {
      const results = [];
      const errors = [];
      
      for (const fileId of fileIds) {
        try {
          // Get file metadata
          const metaResponse = await drive.files.get({
            fileId,
            fields: 'name, mimeType, size'
          });
          
          const mimeType = metaResponse.data.mimeType;
          const fileName = metaResponse.data.name;
          
          let content;
          let downloadMimeType = mimeType;
          
          if (mimeType?.startsWith('application/vnd.google-apps.')) {
            // Google Workspace file - export it
            let exportMimeType = exportFormat || 'text/plain';
            if (!exportFormat) {
              if (mimeType.includes('document')) exportMimeType = 'text/plain';
              else if (mimeType.includes('spreadsheet')) exportMimeType = 'text/csv';
              else if (mimeType.includes('presentation')) exportMimeType = 'text/plain';
            }
            
            const response = await drive.files.export({
              fileId,
              mimeType: exportMimeType
            }, { responseType: format === 'base64' ? 'arraybuffer' : 'text' });
            
            content = response.data;
            downloadMimeType = exportMimeType;
          } else {
            // Regular file
            const response = await drive.files.get({
              fileId,
              alt: 'media'
            }, { responseType: format === 'base64' ? 'arraybuffer' : 'text' });
            
            content = response.data;
          }
          
          if (format === 'base64' && content instanceof ArrayBuffer) {
            content = Buffer.from(content).toString('base64');
          }
          
          results.push({
            fileId,
            name: fileName,
            content,
            mimeType: downloadMimeType,
            size: metaResponse.data.size,
            success: true
          });
        } catch (error) {
          errors.push({
            fileId,
            error: error.message,
            success: false
          });
        }
      }
      
      return formatResponse({
        downloaded: results,
        failed: errors,
        totalRequested: fileIds.length,
        successCount: results.length,
        errorCount: errors.length
      });
    });
  }
);

// Tool: List access proposals
server.tool(
  'list_access_proposals',
  'List access proposals for a file or folder',
  {
    fileId: z.string().describe('File or folder ID'),
    pageSize: z.number().optional().default(10).describe('Number of proposals to return')
  },
  async ({ fileId, pageSize }) => {
    return handleDriveOperation(async (drive) => {
      // Note: Access proposals are part of the Google Drive Activity API
      // This is a simplified implementation using permissions
      const response = await drive.permissions.list({
        fileId,
        fields: 'permissions(id, type, role, emailAddress, displayName, pending)',
        pageSize
      });

      // Filter for pending permissions (access requests)
      const pendingPermissions = response.data.permissions?.filter(p => p.pending) || [];

      return formatResponse({
        proposals: pendingPermissions,
        count: pendingPermissions.length
      });
    });
  }
);

// Tool: Resolve access proposals
server.tool(
  'resolve_access_proposals',
  'Accept or deny a request for access to a file or folder',
  {
    fileId: z.string().describe('File or folder ID'),
    proposalId: z.string().describe('Access proposal/permission ID'),
    action: z.enum(['accept', 'deny']).describe('Action to take on the proposal'),
    role: z.enum(['reader', 'writer', 'commenter']).optional().default('reader').describe('Role to grant if accepting')
  },
  async ({ fileId, proposalId, action, role }) => {
    return handleDriveOperation(async (drive) => {
      if (action === 'deny') {
        // Remove the pending permission
        await drive.permissions.delete({
          fileId,
          permissionId: proposalId
        });

        return formatResponse({
          message: 'Access proposal denied',
          fileId,
          proposalId
        });
      } else {
        // Update the permission to grant access
        const response = await drive.permissions.update({
          fileId,
          permissionId: proposalId,
          requestBody: {
            role,
            pending: false
          },
          fields: 'id, type, role, emailAddress'
        });

        return formatResponse({
          message: 'Access proposal accepted',
          permission: response.data
        });
      }
    });
  }
);

// Start the server
console.error('[Google Drive] Server starting...');
console.error('[Google Drive] Environment variables at startup:');
console.error('[Google Drive] OAuth-related env vars:', {
  has_access_token: !!process.env.ACCESS_TOKEN || !!process.env.access_token,
  has_refresh_token: !!process.env.REFRESH_TOKEN || !!process.env.refresh_token,
  has_client_id: !!process.env.CLIENT_ID || !!process.env.client_id,
  has_client_secret: !!process.env.CLIENT_SECRET || !!process.env.client_secret
});

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error('[Google Drive] MCP server running on stdio transport');
}).catch(error => {
  console.error('[Google Drive] Failed to start server:', error);
  process.exit(1);
});