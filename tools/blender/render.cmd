@echo off
rem Tool3D headless Blender run. Usage: tools\blender\render.cmd <tool.stl[.gz]> <result.json> <outdir> [extra args]
rem Extra args go to tool3d_blender.py, e.g. --samples 128 --frames 24 --no-render
setlocal
set "BLENDER_EXE=%BLENDER%"
if not defined BLENDER_EXE for /d %%D in ("%ProgramFiles%\Blender Foundation\Blender 4.*") do set "BLENDER_EXE=%%D\blender.exe"
if not exist "%BLENDER_EXE%" (echo Blender 4.x not found. Set BLENDER=path\to\blender.exe & exit /b 2)
"%BLENDER_EXE%" -b --factory-startup -noaudio -P "%~dp0tool3d_blender.py" -- --stl "%~1" --result "%~2" --out "%~3" %4 %5 %6 %7 %8 %9
