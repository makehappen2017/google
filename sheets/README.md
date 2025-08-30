# Google Sheets MCP Server

MCP server for Google Sheets operations including reading, writing, and managing spreadsheets.

## Features

- List spreadsheets
- Get spreadsheet metadata
- Read data from ranges
- Write data to ranges
- Append data to sheets
- Clear ranges
- Create new spreadsheets
- Add/delete sheets
- Find and replace text

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure OAuth credentials via environment variables or the admin panel.

3. Run the server:
```bash
npm start
```

## Required Scopes

- `https://www.googleapis.com/auth/spreadsheets` - Full access to spreadsheets
- `https://www.googleapis.com/auth/drive.readonly` - Read access to Drive for listing spreadsheets

## Available Tools

### sheets_list_spreadsheets
List all Google Sheets spreadsheets accessible to the authenticated user.

### sheets_get_spreadsheet
Get metadata about a specific spreadsheet including sheets information.

### sheets_read_range
Read data from a specific range in a spreadsheet.

### sheets_write_range
Write data to a specific range in a spreadsheet.

### sheets_append_data
Append data to the end of a sheet.

### sheets_clear_range
Clear data from a specific range.

### sheets_create_spreadsheet
Create a new Google Sheets spreadsheet.

### sheets_add_sheet
Add a new sheet to an existing spreadsheet.

### sheets_delete_sheet
Delete a sheet from a spreadsheet.

### sheets_find_replace
Find and replace text in a spreadsheet.