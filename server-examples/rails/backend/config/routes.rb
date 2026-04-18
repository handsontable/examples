Rails.application.routes.draw do
  namespace :api do
    resources :orders, only: [:index] do
      collection do
        post   :create_rows
        patch  :update_rows
        delete :remove_rows
      end
    end
  end
end
