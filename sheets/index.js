#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { createAuthClient } from '../shared/auth.js';

// Google Sheets API scopes
const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly'
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
  
  console.error('[Google Sheets MCP] OAuth check:', {
    hasAccessToken: !!accessToken,
    hasRefreshToken: !!refreshToken,
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret
  });
  
  if (!refreshToken && !accessToken) {
    console.error('[Google Sheets MCP] ERROR: No OAuth tokens found');
    throw new Error('OAuth tokens not provided. Please authenticate with Google.');
  }

  return createAuthClient({
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });
};

// Initialize Sheets client
const getSheetsClient = () => {
  try {
    const auth = getOAuth2Client();
    return google.sheets({ version: 'v4', auth });
  } catch (error) {
    console.error('Failed to initialize Sheets client:', error.message);
    return null;
  }
};

// Initialize Drive client for file operations
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
  name: 'google-sheets',
  version: '1.0.0'
});

// Helper function to format responses
const formatResponse = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
});

// Helper function to handle Sheets operations
const handleSheetsOperation = async (operation) => {
  try {
    const sheets = getSheetsClient();
    if (!sheets) {
      throw new Error('Sheets client not initialized. Please check OAuth credentials.');
    }
    return await operation(sheets);
  } catch (error) {
    console.error('Sheets operation failed:', error);
    throw error;
  }
};

// List spreadsheets
server.tool(
  'sheets_list_spreadsheets',
  'List Google Sheets spreadsheets',
  {
    pageSize: z.number().optional().describe('Number of files to return (max 100)'),
    pageToken: z.string().optional().describe('Token for next page of results')
  },
  async (params) => {
    const drive = getDriveClient();
    if (!drive) {
      throw new Error('Drive client not initialized');
    }
    
    try {
      const response = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.spreadsheet'",
        pageSize: params.pageSize || 20,
        pageToken: params.pageToken,
        fields: 'nextPageToken, files(id, name, createdTime, modifiedTime, webViewLink)',
        orderBy: 'modifiedTime desc'
      });
      
      return formatResponse({
        spreadsheets: response.data.files || [],
        nextPageToken: response.data.nextPageToken
      });
    } catch (error) {
      console.error('Failed to list spreadsheets:', error);
      throw error;
    }
  }
);

// Get spreadsheet metadata
server.tool(
  'sheets_get_spreadsheet',
  'Get spreadsheet metadata and sheet information',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.get({
        spreadsheetId: params.spreadsheetId,
        includeGridData: false
      });
      
      return formatResponse({
        spreadsheetId: response.data.spreadsheetId,
        title: response.data.properties.title,
        locale: response.data.properties.locale,
        timeZone: response.data.properties.timeZone,
        sheets: response.data.sheets.map(sheet => ({
          sheetId: sheet.properties.sheetId,
          title: sheet.properties.title,
          index: sheet.properties.index,
          rowCount: sheet.properties.gridProperties.rowCount,
          columnCount: sheet.properties.gridProperties.columnCount
        })),
        spreadsheetUrl: response.data.spreadsheetUrl
      });
    });
  }
);

// Read data from a range
server.tool(
  'sheets_read_range',
  'Read data from a specific range in a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    range: z.string().describe('The A1 notation range (e.g., "Sheet1!A1:D10")')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: params.spreadsheetId,
        range: params.range,
        valueRenderOption: 'FORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING'
      });
      
      return formatResponse({
        range: response.data.range,
        values: response.data.values || [],
        rowCount: response.data.values ? response.data.values.length : 0,
        columnCount: response.data.values && response.data.values[0] ? response.data.values[0].length : 0
      });
    });
  }
);

// Write data to a range
server.tool(
  'sheets_write_range',
  'Write data to a specific range in a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    range: z.string().describe('The A1 notation range (e.g., "Sheet1!A1")'),
    values: z.array(z.array(z.any())).describe('2D array of values to write')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.values.update({
        spreadsheetId: params.spreadsheetId,
        range: params.range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: params.values
        }
      });
      
      return formatResponse({
        updatedRange: response.data.updatedRange,
        updatedRows: response.data.updatedRows,
        updatedColumns: response.data.updatedColumns,
        updatedCells: response.data.updatedCells
      });
    });
  }
);

// Append data to a sheet
server.tool(
  'sheets_append_data',
  'Append data to the end of a sheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    range: z.string().describe('The A1 notation range (e.g., "Sheet1!A:D")'),
    values: z.array(z.array(z.any())).describe('2D array of values to append')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId: params.spreadsheetId,
        range: params.range,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: params.values
        }
      });
      
      return formatResponse({
        updatedRange: response.data.updates.updatedRange,
        updatedRows: response.data.updates.updatedRows,
        updatedColumns: response.data.updates.updatedColumns,
        updatedCells: response.data.updates.updatedCells
      });
    });
  }
);

// Clear a range
server.tool(
  'sheets_clear_range',
  'Clear data from a specific range',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    range: z.string().describe('The A1 notation range to clear')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.values.clear({
        spreadsheetId: params.spreadsheetId,
        range: params.range
      });
      
      return formatResponse({
        clearedRange: response.data.clearedRange,
        message: `Range ${response.data.clearedRange} cleared successfully`
      });
    });
  }
);

// Create a new spreadsheet
server.tool(
  'sheets_create_spreadsheet',
  'Create a new Google Sheets spreadsheet',
  {
    title: z.string().describe('Title of the new spreadsheet'),
    sheetTitles: z.array(z.string()).optional().describe('Titles for initial sheets')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const requestBody = {
        properties: {
          title: params.title
        }
      };
      
      if (params.sheetTitles && params.sheetTitles.length > 0) {
        requestBody.sheets = params.sheetTitles.map((title, index) => ({
          properties: {
            title,
            index
          }
        }));
      }
      
      const response = await sheets.spreadsheets.create({
        requestBody
      });
      
      return formatResponse({
        spreadsheetId: response.data.spreadsheetId,
        title: response.data.properties.title,
        sheets: response.data.sheets.map(sheet => ({
          sheetId: sheet.properties.sheetId,
          title: sheet.properties.title
        })),
        spreadsheetUrl: response.data.spreadsheetUrl
      });
    });
  }
);

// Add a new sheet to existing spreadsheet
server.tool(
  'sheets_add_sheet',
  'Add a new sheet to an existing spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    title: z.string().describe('Title of the new sheet'),
    rowCount: z.number().optional().describe('Number of rows (default 1000)'),
    columnCount: z.number().optional().describe('Number of columns (default 26)')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: params.spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: params.title,
                gridProperties: {
                  rowCount: params.rowCount || 1000,
                  columnCount: params.columnCount || 26
                }
              }
            }
          }]
        }
      });
      
      const addedSheet = response.data.replies[0].addSheet;
      return formatResponse({
        sheetId: addedSheet.properties.sheetId,
        title: addedSheet.properties.title,
        index: addedSheet.properties.index,
        rowCount: addedSheet.properties.gridProperties.rowCount,
        columnCount: addedSheet.properties.gridProperties.columnCount
      });
    });
  }
);

// Delete a sheet
server.tool(
  'sheets_delete_sheet',
  'Delete a sheet from a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetId: z.number().describe('The ID of the sheet to delete')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: params.spreadsheetId,
        requestBody: {
          requests: [{
            deleteSheet: {
              sheetId: params.sheetId
            }
          }]
        }
      });
      
      return formatResponse({
        message: `Sheet with ID ${params.sheetId} deleted successfully`
      });
    });
  }
);

// Get cell
server.tool(
  'sheets_get_cell',
  'Fetch the contents of a specific cell in a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetName: z.string().describe('Name of the sheet'),
    cell: z.string().describe('Cell address in A1 notation (e.g., "B5")')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const range = `${params.sheetName}!${params.cell}`;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: params.spreadsheetId,
        range: range,
        valueRenderOption: 'FORMATTED_VALUE'
      });
      
      return formatResponse({
        cell: params.cell,
        value: response.data.values && response.data.values[0] ? response.data.values[0][0] : null,
        range: response.data.range
      });
    });
  }
);

// Update cell
server.tool(
  'sheets_update_cell',
  'Update a specific cell in a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetName: z.string().describe('Name of the sheet'),
    cell: z.string().describe('Cell address in A1 notation (e.g., "B5")'),
    value: z.any().describe('Value to set in the cell')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const range = `${params.sheetName}!${params.cell}`;
      const response = await sheets.spreadsheets.values.update({
        spreadsheetId: params.spreadsheetId,
        range: range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[params.value]]
        }
      });
      
      return formatResponse({
        updatedRange: response.data.updatedRange,
        updatedCells: response.data.updatedCells
      });
    });
  }
);

// Add single row
server.tool(
  'sheets_add_single_row',
  'Add a single row of data to Google Sheets',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetName: z.string().describe('Name of the sheet'),
    rowData: z.array(z.any()).describe('Array of values for the row')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const range = `${params.sheetName}!A:A`;
      
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId: params.spreadsheetId,
        range: range,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [params.rowData]
        }
      });
      
      return formatResponse({
        updatedRange: response.data.updates.updatedRange,
        updatedRows: response.data.updates.updatedRows,
        updatedCells: response.data.updates.updatedCells
      });
    });
  }
);

// Find row
server.tool(
  'sheets_find_row',
  'Find one or more rows by a column and value',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetName: z.string().describe('Name of the sheet'),
    searchColumn: z.string().describe('Column letter to search in (e.g., "A")'),
    searchValue: z.any().describe('Value to search for'),
    returnAllMatches: z.boolean().optional().describe('Return all matching rows (default false, returns first match)')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      // Get all data from the sheet
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: params.spreadsheetId,
        range: params.sheetName
      });
      
      if (!response.data.values) {
        return formatResponse({ matches: [] });
      }
      
      const columnIndex = params.searchColumn.charCodeAt(0) - 65;
      const matches = [];
      
      response.data.values.forEach((row, index) => {
        if (row[columnIndex] == params.searchValue) {
          matches.push({
            rowNumber: index + 1,
            rowData: row
          });
          if (!params.returnAllMatches) {
            return;
          }
        }
      });
      
      return formatResponse({
        matches: matches,
        totalMatches: matches.length
      });
    });
  }
);

// Update row
server.tool(
  'sheets_update_row',
  'Update a specific row in a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetName: z.string().describe('Name of the sheet'),
    rowNumber: z.number().describe('Row number to update (1-based)'),
    rowData: z.array(z.any()).describe('Array of values for the entire row')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const range = `${params.sheetName}!A${params.rowNumber}`;
      const response = await sheets.spreadsheets.values.update({
        spreadsheetId: params.spreadsheetId,
        range: range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [params.rowData]
        }
      });
      
      return formatResponse({
        updatedRange: response.data.updatedRange,
        updatedRows: response.data.updatedRows,
        updatedColumns: response.data.updatedColumns,
        updatedCells: response.data.updatedCells
      });
    });
  }
);

// Clear cell
server.tool(
  'sheets_clear_cell',
  'Delete the content of a specific cell in a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetName: z.string().describe('Name of the sheet'),
    cell: z.string().describe('Cell address in A1 notation (e.g., "B5")')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const range = `${params.sheetName}!${params.cell}`;
      
      const response = await sheets.spreadsheets.values.clear({
        spreadsheetId: params.spreadsheetId,
        range: range
      });
      
      return formatResponse({
        clearedRange: response.data.clearedRange,
        message: `Cell ${params.cell} cleared successfully`
      });
    });
  }
);

// Add multiple rows
server.tool(
  'sheets_add_multiple_rows',
  'Add multiple rows of data to a Google Sheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetName: z.string().describe('Name of the sheet'),
    rows: z.array(z.array(z.any())).describe('2D array of values (array of rows)'),
    insertDataOption: z.enum(['INSERT_ROWS', 'OVERWRITE']).optional().describe('How to insert data (default INSERT_ROWS)')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const range = `${params.sheetName}!A:A`;
      
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId: params.spreadsheetId,
        range: range,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: params.insertDataOption || 'INSERT_ROWS',
        requestBody: {
          values: params.rows
        }
      });
      
      return formatResponse({
        updatedRange: response.data.updates.updatedRange,
        updatedRows: response.data.updates.updatedRows,
        updatedColumns: response.data.updates.updatedColumns,
        updatedCells: response.data.updates.updatedCells
      });
    });
  }
);

// Create column
server.tool(
  'sheets_create_column',
  'Create a new column in a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetId: z.number().describe('The ID of the sheet'),
    columnIndex: z.number().describe('Position to insert the column (0-based)'),
    columnCount: z.number().optional().describe('Number of columns to insert (default 1)')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: params.spreadsheetId,
        requestBody: {
          requests: [{
            insertDimension: {
              range: {
                sheetId: params.sheetId,
                dimension: 'COLUMNS',
                startIndex: params.columnIndex,
                endIndex: params.columnIndex + (params.columnCount || 1)
              },
              inheritFromBefore: false
            }
          }]
        }
      });
      
      return formatResponse({
        message: `Created ${params.columnCount || 1} column(s) at position ${params.columnIndex + 1}`,
        columnIndex: params.columnIndex,
        columnCount: params.columnCount || 1
      });
    });
  }
);

// Upsert row
server.tool(
  'sheets_upsert_row',
  'Upsert a row of data in a Google Sheet based on a key column',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetName: z.string().describe('Name of the sheet'),
    keyColumn: z.string().describe('Column letter to check for existing value (e.g., "A")'),
    keyValue: z.any().describe('Value to search for in the key column'),
    rowData: z.array(z.any()).describe('Array of values for the entire row')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      // First, find if row exists
      const searchRange = `${params.sheetName}!${params.keyColumn}:${params.keyColumn}`;
      const searchResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: params.spreadsheetId,
        range: searchRange
      });
      
      let rowIndex = -1;
      if (searchResponse.data.values) {
        rowIndex = searchResponse.data.values.findIndex(row => row[0] == params.keyValue);
      }
      
      if (rowIndex !== -1) {
        // Update existing row
        const updateRange = `${params.sheetName}!A${rowIndex + 1}`;
        const response = await sheets.spreadsheets.values.update({
          spreadsheetId: params.spreadsheetId,
          range: updateRange,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [params.rowData]
          }
        });
        return formatResponse({
          action: 'updated',
          range: response.data.updatedRange,
          updatedCells: response.data.updatedCells
        });
      } else {
        // Append new row
        const appendRange = `${params.sheetName}!A:A`;
        const response = await sheets.spreadsheets.values.append({
          spreadsheetId: params.spreadsheetId,
          range: appendRange,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: [params.rowData]
          }
        });
        return formatResponse({
          action: 'inserted',
          range: response.data.updates.updatedRange,
          updatedCells: response.data.updates.updatedCells
        });
      }
    });
  }
);

// Update multiple rows
server.tool(
  'sheets_update_multiple_rows',
  'Update multiple rows in a spreadsheet defined by a range',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    range: z.string().describe('The A1 notation range (e.g., "Sheet1!A2:D5")'),
    values: z.array(z.array(z.any())).describe('2D array of values to update')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.values.update({
        spreadsheetId: params.spreadsheetId,
        range: params.range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: params.values
        }
      });
      
      return formatResponse({
        updatedRange: response.data.updatedRange,
        updatedRows: response.data.updatedRows,
        updatedColumns: response.data.updatedColumns,
        updatedCells: response.data.updatedCells
      });
    });
  }
);

// List worksheets
server.tool(
  'sheets_list_worksheets',
  'Get a list of all worksheets in a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.get({
        spreadsheetId: params.spreadsheetId
      });
      
      return formatResponse({
        spreadsheetTitle: response.data.properties.title,
        worksheets: response.data.sheets.map(sheet => ({
          sheetId: sheet.properties.sheetId,
          title: sheet.properties.title,
          index: sheet.properties.index,
          sheetType: sheet.properties.sheetType,
          gridProperties: {
            rowCount: sheet.properties.gridProperties.rowCount,
            columnCount: sheet.properties.gridProperties.columnCount
          }
        }))
      });
    });
  }
);

// Insert comment
server.tool(
  'sheets_insert_comment',
  'Insert a comment into a spreadsheet cell',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetId: z.number().describe('The ID of the sheet'),
    rowIndex: z.number().describe('Row index (0-based)'),
    columnIndex: z.number().describe('Column index (0-based)'),
    comment: z.string().describe('Comment text to insert')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: params.spreadsheetId,
        requestBody: {
          requests: [{
            updateCells: {
              range: {
                sheetId: params.sheetId,
                startRowIndex: params.rowIndex,
                endRowIndex: params.rowIndex + 1,
                startColumnIndex: params.columnIndex,
                endColumnIndex: params.columnIndex + 1
              },
              rows: [{
                values: [{
                  note: params.comment
                }]
              }],
              fields: 'note'
            }
          }]
        }
      });
      
      return formatResponse({
        message: 'Comment inserted successfully',
        sheetId: params.sheetId,
        location: `Row ${params.rowIndex + 1}, Column ${String.fromCharCode(65 + params.columnIndex)}`
      });
    });
  }
);

// Insert anchored note
server.tool(
  'sheets_insert_note',
  'Insert a note on a spreadsheet cell',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetName: z.string().describe('Name of the sheet'),
    cell: z.string().describe('Cell address in A1 notation (e.g., "B5")'),
    note: z.string().describe('Note text to insert')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      // Get sheet ID
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: params.spreadsheetId
      });
      
      const sheet = spreadsheet.data.sheets.find(s => s.properties.title === params.sheetName);
      if (!sheet) {
        throw new Error(`Sheet "${params.sheetName}" not found`);
      }
      
      // Convert A1 notation to row/column indices
      const match = params.cell.match(/^([A-Z]+)(\d+)$/);
      if (!match) {
        throw new Error('Invalid cell notation');
      }
      
      const columnIndex = match[1].split('').reduce((acc, char) => acc * 26 + char.charCodeAt(0) - 65, 0);
      const rowIndex = parseInt(match[2]) - 1;
      
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: params.spreadsheetId,
        requestBody: {
          requests: [{
            updateCells: {
              range: {
                sheetId: sheet.properties.sheetId,
                startRowIndex: rowIndex,
                endRowIndex: rowIndex + 1,
                startColumnIndex: columnIndex,
                endColumnIndex: columnIndex + 1
              },
              rows: [{
                values: [{
                  note: params.note
                }]
              }],
              fields: 'note'
            }
          }]
        }
      });
      
      return formatResponse({
        message: 'Note inserted successfully',
        cell: params.cell,
        sheet: params.sheetName
      });
    });
  }
);

// Get values in range
server.tool(
  'sheets_get_values_in_range',
  'Get all values or values from a range of cells using A1 notation',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    range: z.string().describe('The A1 notation range (e.g., "Sheet1!A1:D10" or "Sheet1" for all)'),
    majorDimension: z.enum(['ROWS', 'COLUMNS']).optional().describe('Major dimension (default ROWS)'),
    valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).optional().describe('How values should be represented (default FORMATTED_VALUE)')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: params.spreadsheetId,
        range: params.range,
        majorDimension: params.majorDimension || 'ROWS',
        valueRenderOption: params.valueRenderOption || 'FORMATTED_VALUE'
      });
      
      return formatResponse({
        range: response.data.range,
        majorDimension: response.data.majorDimension,
        values: response.data.values || [],
        rowCount: response.data.values ? response.data.values.length : 0,
        columnCount: response.data.values && response.data.values[0] ? response.data.values[0].length : 0
      });
    });
  }
);

// Get spreadsheet by ID
server.tool(
  'sheets_get_spreadsheet_by_id',
  'Returns the spreadsheet at the given ID with full metadata',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    includeGridData: z.boolean().optional().describe('Include grid data (default false)')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.get({
        spreadsheetId: params.spreadsheetId,
        includeGridData: params.includeGridData || false
      });
      
      return formatResponse({
        spreadsheetId: response.data.spreadsheetId,
        properties: {
          title: response.data.properties.title,
          locale: response.data.properties.locale,
          autoRecalc: response.data.properties.autoRecalc,
          timeZone: response.data.properties.timeZone
        },
        sheets: response.data.sheets.map(sheet => ({
          properties: {
            sheetId: sheet.properties.sheetId,
            title: sheet.properties.title,
            index: sheet.properties.index,
            sheetType: sheet.properties.sheetType,
            gridProperties: sheet.properties.gridProperties
          },
          data: params.includeGridData ? sheet.data : undefined
        })),
        spreadsheetUrl: response.data.spreadsheetUrl
      });
    });
  }
);

// Delete worksheet
server.tool(
  'sheets_delete_worksheet',
  'Delete a specific worksheet from a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetId: z.number().describe('The ID of the sheet to delete')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: params.spreadsheetId,
        requestBody: {
          requests: [{
            deleteSheet: {
              sheetId: params.sheetId
            }
          }]
        }
      });
      
      return formatResponse({
        message: `Worksheet with ID ${params.sheetId} deleted successfully`
      });
    });
  }
);

// Delete rows
server.tool(
  'sheets_delete_rows',
  'Delete specified rows from a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetId: z.number().describe('The ID of the sheet'),
    startIndex: z.number().describe('Starting row index to delete (0-based)'),
    endIndex: z.number().describe('Ending row index (exclusive, 0-based)')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: params.spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: params.sheetId,
                dimension: 'ROWS',
                startIndex: params.startIndex,
                endIndex: params.endIndex
              }
            }
          }]
        }
      });
      
      return formatResponse({
        message: `Deleted rows ${params.startIndex + 1} to ${params.endIndex}`,
        deletedCount: params.endIndex - params.startIndex
      });
    });
  }
);

// Create worksheet
server.tool(
  'sheets_create_worksheet',
  'Create a blank worksheet with a title in an existing spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    title: z.string().describe('Title of the new worksheet'),
    rowCount: z.number().optional().describe('Number of rows (default 1000)'),
    columnCount: z.number().optional().describe('Number of columns (default 26)'),
    tabColor: z.object({
      red: z.number().optional(),
      green: z.number().optional(),
      blue: z.number().optional()
    }).optional().describe('RGB color for the tab')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const request = {
        addSheet: {
          properties: {
            title: params.title,
            gridProperties: {
              rowCount: params.rowCount || 1000,
              columnCount: params.columnCount || 26
            }
          }
        }
      };
      
      if (params.tabColor) {
        request.addSheet.properties.tabColor = params.tabColor;
      }
      
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: params.spreadsheetId,
        requestBody: {
          requests: [request]
        }
      });
      
      const addedSheet = response.data.replies[0].addSheet;
      return formatResponse({
        sheetId: addedSheet.properties.sheetId,
        title: addedSheet.properties.title,
        index: addedSheet.properties.index,
        gridProperties: addedSheet.properties.gridProperties
      });
    });
  }
);

// Create new spreadsheet
server.tool(
  'sheets_create_new_spreadsheet',
  'Create a blank spreadsheet or duplicate an existing spreadsheet',
  {
    title: z.string().describe('Title of the new spreadsheet'),
    sheetTitles: z.array(z.string()).optional().describe('Titles for initial sheets'),
    locale: z.string().optional().describe('Locale of the spreadsheet (e.g., "en_US")'),
    timeZone: z.string().optional().describe('Time zone (e.g., "America/New_York")'),
    duplicateFrom: z.string().optional().describe('ID of spreadsheet to duplicate')
  },
  async (params) => {
    const drive = getDriveClient();
    if (!drive) {
      throw new Error('Drive client not initialized');
    }
    
    try {
      if (params.duplicateFrom) {
        // Duplicate existing spreadsheet
        const response = await drive.files.copy({
          fileId: params.duplicateFrom,
          requestBody: {
            name: params.title
          }
        });
        
        return formatResponse({
          spreadsheetId: response.data.id,
          title: response.data.name,
          action: 'duplicated',
          webViewLink: `https://docs.google.com/spreadsheets/d/${response.data.id}/edit`
        });
      } else {
        // Create new spreadsheet
        return handleSheetsOperation(async (sheets) => {
          const requestBody = {
            properties: {
              title: params.title,
              locale: params.locale || 'en_US',
              timeZone: params.timeZone || 'America/New_York'
            }
          };
          
          if (params.sheetTitles && params.sheetTitles.length > 0) {
            requestBody.sheets = params.sheetTitles.map((title, index) => ({
              properties: {
                title,
                index
              }
            }));
          }
          
          const response = await sheets.spreadsheets.create({
            requestBody
          });
          
          return formatResponse({
            spreadsheetId: response.data.spreadsheetId,
            title: response.data.properties.title,
            action: 'created',
            sheets: response.data.sheets.map(sheet => ({
              sheetId: sheet.properties.sheetId,
              title: sheet.properties.title
            })),
            spreadsheetUrl: response.data.spreadsheetUrl
          });
        });
      }
    } catch (error) {
      console.error('Failed to create spreadsheet:', error);
      throw error;
    }
  }
);

// Copy worksheet
server.tool(
  'sheets_copy_worksheet',
  'Copy an existing worksheet to another Google Sheets file',
  {
    sourceSpreadsheetId: z.string().describe('The ID of the source spreadsheet'),
    sourceSheetId: z.number().describe('The ID of the sheet to copy'),
    destinationSpreadsheetId: z.string().describe('The ID of the destination spreadsheet')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const response = await sheets.spreadsheets.sheets.copyTo({
        spreadsheetId: params.sourceSpreadsheetId,
        sheetId: params.sourceSheetId,
        requestBody: {
          destinationSpreadsheetId: params.destinationSpreadsheetId
        }
      });
      
      return formatResponse({
        sheetId: response.data.sheetId,
        title: response.data.title,
        index: response.data.index,
        message: 'Worksheet copied successfully'
      });
    });
  }
);

// Clear rows
server.tool(
  'sheets_clear_rows',
  'Delete the content of a row or rows in a spreadsheet (rows appear as blank)',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    sheetName: z.string().describe('Name of the sheet'),
    startRow: z.number().describe('Starting row number (1-based)'),
    endRow: z.number().optional().describe('Ending row number (inclusive, 1-based). If not provided, only startRow is cleared')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const endRow = params.endRow || params.startRow;
      const range = `${params.sheetName}!A${params.startRow}:ZZ${endRow}`;
      
      const response = await sheets.spreadsheets.values.clear({
        spreadsheetId: params.spreadsheetId,
        range: range
      });
      
      return formatResponse({
        clearedRange: response.data.clearedRange,
        message: `Cleared rows ${params.startRow} to ${endRow}`
      });
    });
  }
);

// Find and replace
server.tool(
  'sheets_find_replace',
  'Find and replace text in a spreadsheet',
  {
    spreadsheetId: z.string().describe('The ID of the spreadsheet'),
    find: z.string().describe('Text to find'),
    replacement: z.string().describe('Replacement text'),
    sheetId: z.number().optional().describe('Specific sheet ID (optional, searches all if not provided)'),
    matchCase: z.boolean().optional().describe('Match case (default false)'),
    matchEntireCell: z.boolean().optional().describe('Match entire cell (default false)')
  },
  async (params) => {
    return handleSheetsOperation(async (sheets) => {
      const request = {
        find: params.find,
        replacement: params.replacement,
        matchCase: params.matchCase || false,
        matchEntireCell: params.matchEntireCell || false,
        allSheets: !params.sheetId
      };
      
      if (params.sheetId) {
        request.sheetId = params.sheetId;
      }
      
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: params.spreadsheetId,
        requestBody: {
          requests: [{
            findReplace: request
          }]
        }
      });
      
      const result = response.data.replies[0].findReplace;
      return formatResponse({
        valuesChanged: result.valuesChanged,
        rowsChanged: result.rowsChanged,
        sheetsChanged: result.sheetsChanged,
        occurrencesChanged: result.occurrencesChanged
      });
    });
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[google-sheets] Server started successfully');
}

main().catch((error) => {
  console.error('[google-sheets] Server error:', error);
  process.exit(1);
});