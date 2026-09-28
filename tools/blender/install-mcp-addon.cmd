@echo off
rem Install + enable the MCP for Blender add-on (mcp-for-blender==2.1.1) headlessly. Needs uv (winget install astral-sh.uv).
setlocal
set "BLENDER_EXE=%BLENDER%"
if not defined BLENDER_EXE for /d %%D in ("%LOCALAPPDATA%\Programs\Blender\blender-4.*") do set "BLENDER_EXE=%%D\blender.exe"
if not exist "%BLENDER_EXE%" (echo Blender 4.x not found. Set BLENDER=path\to\blender.exe & exit /b 2)
set DISABLE_TELEMETRY=true
for /f "delims=" %%A in ('"%BLENDER_EXE%" -b --factory-startup -noaudio --python-expr "import bpy;print('ADDONS='+bpy.utils.user_resource('SCRIPTS',path='addons',create=True))" ^| findstr /b ADDONS^=') do set "%%A"
set "BLENDERMCP_ADDONS_DIR=%ADDONS%"
uvx --from mcp-for-blender==2.1.1 mcp-for-blender install-addon || exit /b 1
"%BLENDER_EXE%" -b -noaudio --python-expr "import bpy,addon_utils;bpy.ops.preferences.addon_enable(module='blender_mcp');bpy.ops.wm.save_userpref();print('blender_mcp enabled:',addon_utils.check('blender_mcp'))"
