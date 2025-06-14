(function () {
  class LoveWall {
    constructor(containerId) {
      this.container = document.getElementById(containerId);
      this.users = [];
      this.totalCount = 0;
      this.init();
    }

    async init() {
      this.container.innerHTML = `
                        <div class="title">Loading...</div>
                        <div class="users-slider-container">
                            <div class="users-slider">
                                <div class="loading">Loading users...</div>
                            </div>
                        </div>
                    `;

      try {
        await this.loadUsers();
        this.render();
      } catch (error) {
        console.error("Error loading users:", error);
        this.showError("Failed to load users");
      }
    }

    async loadUsers() {
      const response = await fetch("https://list.freemyx.com/list.json");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      this.users = data.users.slice(0, 20);
      this.totalCount = data.count;
    }

    render() {
      this.container.innerHTML = `
                        <div class="title">${this.totalCount.toLocaleString()} people freed their data</div>
                        <div class="users-slider-container">
                            <div class="users-slider">
                                ${this.createSliderContent()}
                            </div>
                        </div>
                    `;

      // Add hover pause functionality
      const slider = this.container.querySelector(".users-slider");
      slider.addEventListener("mouseenter", () => {
        slider.style.animationPlayState = "paused";
      });
      slider.addEventListener("mouseleave", () => {
        slider.style.animationPlayState = "running";
      });
    }

    createSliderContent() {
      let html = "";
      const sliderItems = [];

      this.users.forEach((user) => {
        const avatarUrl = user.large_profile_pic_url || user.profile_image_url;
        const twitterUrl = `https://twitter.com/${user.username}`;

        sliderItems.push(`
                            <div class="user-item" onclick="window.open('${twitterUrl}', '_blank')">
                                <img src="${avatarUrl}" 
                                     alt="${user.name}" 
                                     class="user-avatar"
                                     onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHZpZXdCb3g9IjAgMCA4MCA4MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iNDAiIGN5PSI0MCIgcj0iNDAiIGZpbGw9IiMzMzMzMzMiLz4KPHN2ZyB4PSIyNCIgeT0iMjQiIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSIjNjY2NjY2Ij4KPHA+VXNlcjwvcD4KPC9zdmc+Cjwvc3ZnPgo='">
                                <div class="user-tooltip">@${user.username}</div>
                            </div>
                        `);
      });

      const content = sliderItems.join("");
      return content + content; // Duplicate for seamless loop
    }

    showError(message) {
      this.container.innerHTML = `
                        <div class="title">Error</div>
                        <div class="error">${message}</div>
                    `;
    }
  }

  // Auto-initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => new LoveWall("lovewall"),
    );
  } else {
    new LoveWall("lovewall");
  }
})();
