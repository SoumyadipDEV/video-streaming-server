const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const parseRange = require('range-parser');
const compression = require('compression');

class VideoStreamingServer {
    constructor(videoDirectory) {
        this.app = express();
        this.videoDirectory = videoDirectory;
        this.playbackData = {};
        this.setupRoutes();
    }

    setupRoutes() {
        // Middleware to serve static files from the public folder
        this.app.use(express.static(path.join(__dirname, 'public'), {
            maxAge: '1d', // Cache static files for one day
        }));

        // Enable compression for faster responses
        this.app.use(compression());

        // Endpoint to list available videos
        this.app.get('/videos', (req, res) => {
            try {
                const files = fs.readdirSync(this.videoDirectory);
                const videoFiles = files.filter(file => {
                    const ext = path.extname(file).toLowerCase();
                    return ['.mp4', '.avi', '.mkv', '.mov'].includes(ext);
                });
                res.json(videoFiles);
            } catch (error) {
                res.status(500).json({ error: 'Failed to list videos' });
            }
        });

        // Video metadata endpoint
        this.app.get('/metadata/:filename', (req, res) => {
            const filename = req.params.filename;
            const filepath = path.join(this.videoDirectory, filename);

            try {
                fs.accessSync(filepath);
                // Return hardcoded metadata as a placeholder
                res.json({
                    subtitles: ['English', 'Spanish'],
                    audioTracks: ['English', 'Hindi'],
                });
            } catch (error) {
                res.status(404).json({ error: 'Metadata not found' });
            }
        });

        // Video streaming endpoint
        this.app.get('/stream/:filename', (req, res) => {
            const filename = req.params.filename;
            const filepath = path.join(this.videoDirectory, filename);

            try {
                // Verify file exists
                fs.accessSync(filepath);

                const stat = fs.statSync(filepath);
                const fileSize = stat.size;
                const contentType = mime.lookup(filepath);

                const range = req.headers.range;

                if (range) {
                    // Parse Range header for partial content
                    const parsedRange = parseRange(fileSize, range);

                    if (parsedRange && parsedRange.type === 'bytes' && parsedRange.length > 0) {
                        const { start, end } = parsedRange[0];

                        // Stream only the requested byte range
                        res.writeHead(206, {
                            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                            'Accept-Ranges': 'bytes',
                            'Content-Length': end - start + 1,
                            'Content-Type': contentType,
                        });

                        const stream = fs.createReadStream(filepath, { start, end });
                        stream.pipe(res);
                        return; // Ensure no further code runs
                    } else {
                        res.status(416).send('Requested range not satisfiable');
                        return;
                    }
                }

                // Full video if no range header is provided
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': contentType,
                });

                const stream = fs.createReadStream(filepath);
                stream.pipe(res);
            } catch (error) {
                console.error('Streaming error:', error);
                if (!res.headersSent) {
                    res.status(404).json({ error: 'Video not found' });
                }
            }
        });

        // File download endpoint
        this.app.get('/download/:filename', (req, res) => {
            const filename = req.params.filename;
            const filepath = path.join(this.videoDirectory, filename);

            try {
                // Verify if the file exists
                fs.accessSync(filepath);

                res.download(filepath, filename, (err) => {
                    if (err) {
                        console.error('Error during file download:', err);
                        if (!res.headersSent) {
                            res.status(500).send('Error downloading file');
                        }
                    }
                });
            } catch (error) {
                console.error('File not found:', error);
                res.status(404).json({ error: 'File not found' });
            }
        });

        // Save playback position
        this.app.post('/save-playback', express.json(), (req, res) => {
            const { video, position } = req.body;
            const clientId = req.ip; // Simplistic client ID based on IP address

            if (!video || position === undefined) {
                return res.status(400).json({ error: 'Invalid data' });
            }

            // Save playback position
            if (!this.playbackData[clientId]) {
                this.playbackData[clientId] = {};
            }
            this.playbackData[clientId][video] = position;
            res.json({ message: 'Playback position saved' });
        });

        // Retrieve playback position
        this.app.get('/get-playback/:filename', (req, res) => {
            const filename = req.params.filename;
            const clientId = req.ip; // Simplistic client ID based on IP address

            const position = this.playbackData[clientId]?.[filename] || 0;
            res.json({ position });
        });
    }

    start(port = 3000) {
        this.app.listen(port, () => {
            console.log(`Video streaming server running on http://localhost:${port}`);
        });
    }
}

// Example usage
const server = new VideoStreamingServer('./videos');
server.start();

module.exports = VideoStreamingServer;