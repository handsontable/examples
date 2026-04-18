Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    origins "http://localhost:5173",  # Vite dev server
            "http://localhost:3000"

    resource "/api/*",
      headers: :any,
      methods: [:get, :post, :patch, :put, :delete, :options],
      expose:  ["Content-Type"]
  end
end
