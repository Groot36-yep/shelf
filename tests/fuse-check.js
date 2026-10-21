// Used by the Windows build: if the shipped Shelf.exe ever runs this file, its RunAsNode fuse is on (it must be off).
require('fs').writeFileSync('fuse-ran.txt', 'ran');
