const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const parseRange = require('range-parser');
const compression = require('compression');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');

class VideoStreamingServer {
    constructor(videoDirectory, transcodedDirectory) {
        this.app = express();
        this.videoDirectory = videoDirectory;
        this.transcodedDirectory = transcodedDirectory || path.join(videoDirectory, 'transcoded');
        this.playbackData = {};
        
        // Ensure transcoded directory exists
        if (!fs.existsSync(this.transcodedDirectory)) {
            fs.mkdirSync(this.transcodedDirectory, { recursive: true });
        }

        this.setupRoutes();
    }

    // Transcode video to web-compatible format
    transcodeVideo(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .output(outputPath)
                // Web-compatible video codec
                .videoCodec('libx264')
                // Web-compatible audio codec
                .audioCodec('aac')
                // Ensure compatibility with most browsers
                .format('mp4')
                // Adaptive bitrate for web streaming
                .videoBitrate('1000k')
                .audioBitrate('128k')
                // Additional web optimization settings
                .addOptions([
                    '-profile:v baseline', 
                    '-level 3.0', 
                    '-start_number 0', 
                    '-hls_time 10', 
                    '-hls_list_size 0'
                ])
                .on('end', () => resolve(outputPath))
                .on('error', (err) => reject(err))
                .save(outputPath);
        });
    }

    setupRoutes() {
        // Middleware to serve static files from the public folder
        this.app.use(express.static(path.join(__dirname, 'public'), {
            maxAge: '1d', // Cache static files for one day
        }));

        // Enable compression for faster responses
        this.app.use(compression());

        // Updated videos endpoint to include transcoding status
        this.app.get('/videos', async (req, res) => {
            try {
                const files = fs.readdirSync(this.videoDirectory);
                const videoFiles = await Promise.all(files
                    .filter(file => {
                        const ext = path.extname(file).toLowerCase();
                        return ['.mp4', '.avi', '.mkv', '.mov'].includes(ext);
                    })
                    .map(async (filename) => {
                        const inputPath = path.join(this.videoDirectory, filename);
                        const transcodedFilename = `${path.basename(filename, path.extname(filename))}.mp4`;
                        const transcodedPath = path.join(this.transcodedDirectory, transcodedFilename);

                        // Check if transcoded version exists
                        const isTranscoded = fs.existsSync(transcodedPath);

                        return {
                            original: filename,
                            transcoded: transcodedFilename,
                            isTranscoded
                        };
                    })
                );

                res.json(videoFiles);
            } catch (error) {
                res.status(500).json({ error: 'Failed to list videos' });
            }
        });

        // Endpoint to trigger transcoding
        this.app.post('/transcode/:filename', async (req, res) => {
            const filename = req.params.filename;
            const inputPath = path.join(this.videoDirectory, filename);
            const transcodedFilename = `${path.basename(filename, path.extname(filename))}_${uuidv4()}.mp4`;
            const transcodedPath = path.join(this.transcodedDirectory, transcodedFilename);

            try {
                // Verify input file exists
                fs.accessSync(inputPath);

                // Start transcoding
                await this.transcodeVideo(inputPath, transcodedPath);

                res.json({
                    message: 'Video transcoded successfully',
                    transcodedFilename
                });
            } catch (error) {
                console.error('Transcoding error:', error);
                res.status(500).json({ 
                    error: 'Failed to transcode video', 
                    details: error.message 
                });
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

        // Updated streaming endpoint to prefer transcoded videos
        this.app.get('/stream/:filename', async (req, res) => {
            const filename = req.params.filename;
            const transcodedFilename = `${path.basename(filename, path.extname(filename))}.mp4`;
            
            let filepath;
            try {
                // First, try transcoded video
                const transcodedPath = path.join(this.transcodedDirectory, transcodedFilename);
                if (fs.existsSync(transcodedPath)) {
                    filepath = transcodedPath;
                } else {
                    // Fall back to original video
                    filepath = path.join(this.videoDirectory, filename);
                    fs.accessSync(filepath);
                }

                const stat = fs.statSync(filepath);
                const fileSize = stat.size;
                const contentType = mime.lookup(filepath);

                const range = req.headers.range;

                if (range) {
                    const parsedRange = parseRange(fileSize, range);

                    if (parsedRange && parsedRange.type === 'bytes' && parsedRange.length > 0) {
                        const { start, end } = parsedRange[0];

                        res.writeHead(206, {
                            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                            'Accept-Ranges': 'bytes',
                            'Content-Length': end - start + 1,
                            'Content-Type': contentType,
                        });

                        const stream = fs.createReadStream(filepath, { start, end });
                        stream.pipe(res);
                        return;
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