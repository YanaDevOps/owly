.PHONY: all build blur clean help

# Variables
BINARY := owly
GOFLAGS := -trimpath -ldflags='-s -w'
STATIC_DIR := static/third-party/tasks-vision
MODELS_DIR := $(STATIC_DIR)/models
MEDIAPIPE_URL := https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite

# Build targets
all: build blur

# Build Owly binary (optimized, stripped)
build:
	@echo "Building $(BINARY)..."
	CGO_ENABLED=0 go build $(GOFLAGS) -o $(BINARY)
	@echo "✓ Built: ./$(BINARY)"

# Install MediaPipe library for background blur
blur:
	@echo "Installing MediaPipe for background blur..."
	@mkdir -p $(STATIC_DIR) $(MODELS_DIR)
	@tmp=$$(mktemp -d) && \
		cd $$tmp && \
		npm pack @mediapipe/tasks-vision >/dev/null 2>&1 && \
		tar xzf mediapipe-tasks-vision-*.tgz && \
		rm -rf $(abspath $(STATIC_DIR)) && \
		mv package $(abspath $(STATIC_DIR)) && \
		rm -rf $$tmp
	@mkdir -p $(MODELS_DIR)
	wget -q --show-progress $(MEDIAPIPE_URL) -O $(MODELS_DIR)/selfie_segmenter.tflite
	@echo "✓ Background blur enabled"

# Clean build artifacts
clean:
	@rm -rf $(BINARY) mediapipe
	@echo "✓ Cleaned"

help:
	@echo "Owly Makefile"
	@echo ""
	@echo "  make build   - Build optimized binary"
	@echo "  make blur    - Install background blur (MediaPipe)"
	@echo "  make all     - Build with blur enabled (default)"
	@echo "  make clean   - Remove build artifacts"
