var slideIndex = 0;
var n = 0;
var skip_rec = false;

class CatCarousel {
    constructor() {
        this.slideIndex = 0;
        this.n = 0;
        this.skip_rec = false;
        this.element = document.getElementById("carousel");

        this.getImages();

        this.next = document.getElementById("next");
        this.prev = document.getElementById("prev");

        this.next.addEventListener("click", function() {
            this.plusSlides(1);
        }.bind(this));

        this.prev.addEventListener("click", function() {
            this.plusSlides(-1);
        }.bind(this));
    }

    getImages() {
        this.images = [
            "1E00C9D8-C984-4CA3-9892-21798B1BC08C.JPG",
            "IMG_1059.jpeg",
            "IMG_1243.jpeg",
            "IMG_1418.jpeg",
            "IMG_1419.JPG",
            "IMG_1439.jpeg",
            "IMG_1502.jpeg",
            "IMG_1601.JPG",
            "IMG_2177.JPG",
            "IMG_2343.jpeg",
            "IMG_2397.PNG",
            "IMG_2408.JPG",
            "IMG_2452.jpeg",
            "IMG_2503.jpeg",
            "IMG_2518.JPG",
            "IMG_2538.JPG",
            "IMG_2589.JPG",
            "IMG_2976.jpeg",
            "IMG_3126.JPG",
            "IMG_3179.jpeg",
            "IMG_3342.jpeg",
            "IMG_3393.JPG",
            "IMG_3712.JPG",
            "IMG_4129.jpeg",
            "IMG_4157.jpeg",
            "IMG_4249.jpeg",
            "IMG_5191.jpeg",
            "IMG_5995.jpeg",
            "IMG_6057.jpeg",
            "IMG_6096.jpeg",
            "IMG_6225.jpeg",
            "IMG_6567.jpeg",
            "IMG_6932.jpeg",
            "IMG_7459.jpeg",
            "IMG_7467.JPG"
        ]
            
        this.n = this.images.length;
    }

    showSlides() {
        var self = this;

        if (this.skip_rec) {
            this.skip_rec = false;
        } else {
            this.setSlide();
        }

        // wait 5 seconds before changing the image
        setTimeout(function() {
            if (!self.skip_rec) {
                self.slideIndex++;
                if (self.slideIndex >= self.n) {
                    self.slideIndex = 0;
                }
            }
            self.showSlides();
        }, 5000);
    }

    plusSlides(n) {
        this.slideIndex += n;

        if (this.slideIndex >= this.n) {
            this.slideIndex = 0;
        } else if (this.slideIndex < 0) {
            this.slideIndex = this.n - 1;
        }

        
        this.setSlide();
        this.skip_rec = true;
    }

    setSlide() {        
        var self = this

        this.element.classList.add("slideout");
        setTimeout(function() {
            self.element.style.backgroundImage = "url(./assets/images/cats/" + self.images[self.slideIndex] + ")";
            self.element.classList.remove("slideout");
            void self.element.offsetWidth;
            self.element.classList.add("slidein")
        }, 500);
            }
}

var catCarousel = new CatCarousel();
catCarousel.showSlides();