param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$Destination
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

if (-not ([System.Management.Automation.PSTypeName]'PetSpriteBackgroundExtractor').Type) {
    $drawingAssembly = [System.Drawing.Bitmap].Assembly.Location
    $drawingDirectory = [System.IO.Path]::GetDirectoryName($drawingAssembly)
    $drawingReferences = @(
        [System.IO.Directory]::GetFiles($drawingDirectory, 'System.Drawing*.dll')
        [System.IO.Directory]::GetFiles($drawingDirectory, 'System.Private.Windows*.dll')
    )
    Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class PetSpriteBackgroundExtractor
{
    private static bool IsPaleNeutral(byte red, byte green, byte blue)
    {
        int min = Math.Min(red, Math.Min(green, blue));
        int max = Math.Max(red, Math.Max(green, blue));
        return min >= 215 && max - min <= 26;
    }

    public static void Extract(string source, string destination)
    {
        using (var original = new Bitmap(source))
        using (var output = new Bitmap(original.Width, original.Height, PixelFormat.Format32bppArgb))
        {
            using (var graphics = Graphics.FromImage(output))
            {
                graphics.DrawImageUnscaled(original, 0, 0);
            }

            var rect = new Rectangle(0, 0, output.Width, output.Height);
            var data = output.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            int stride = data.Stride;
            byte[] pixels = new byte[stride * output.Height];
            Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);

            int width = output.Width;
            int height = output.Height;
            bool[] visited = new bool[width * height];
            int[] queue = new int[width * height];
            int head = 0;
            int tail = 0;

            Action<int, int> enqueue = (x, y) => {
                if (x < 0 || y < 0 || x >= width || y >= height) return;
                int position = y * width + x;
                if (visited[position]) return;
                int offset = y * stride + x * 4;
                byte blue = pixels[offset];
                byte green = pixels[offset + 1];
                byte red = pixels[offset + 2];
                if (!IsPaleNeutral(red, green, blue)) return;
                visited[position] = true;
                queue[tail++] = position;
            };

            for (int x = 0; x < width; x++) {
                enqueue(x, 0);
                enqueue(x, height - 1);
            }
            for (int y = 0; y < height; y++) {
                enqueue(0, y);
                enqueue(width - 1, y);
            }

            while (head < tail)
            {
                int position = queue[head++];
                int x = position % width;
                int y = position / width;
                int offset = y * stride + x * 4;
                pixels[offset] = 0;
                pixels[offset + 1] = 0;
                pixels[offset + 2] = 0;
                pixels[offset + 3] = 0;
                enqueue(x - 1, y);
                enqueue(x + 1, y);
                enqueue(x, y - 1);
                enqueue(x, y + 1);
            }

            Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            output.UnlockBits(data);
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            output.Save(destination, ImageFormat.Png);
        }
    }
}
'@
}

$sourcePath = [System.IO.Path]::GetFullPath($Source)
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
[PetSpriteBackgroundExtractor]::Extract($sourcePath, $destinationPath)
Write-Output $destinationPath
